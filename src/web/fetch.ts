import { lookup } from "node:dns/promises";
import { isIP, isIPv4, isIPv6 } from "node:net";
import TurndownService from "turndown";

export interface FetchResult {
	/** The content (markdown for HTML, raw for JSON/text) */
	content: string;
	/** Original content type from response headers */
	contentType: string;
	/** Whether content was truncated */
	truncated: boolean;
}

const MAX_CONTENT_LENGTH = 100_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10MB
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 10;

// -- SSRF protection --
//
// The LLM controls the URL passed to this tool. Without filtering, it can
// reach loopback, private RFC1918 ranges, and link-local addresses including
// the cloud-metadata endpoint (169.254.169.254). We block both literal IPs
// and hostnames that DNS-resolve into those ranges.

function isPrivateIPv4(ip: string): boolean {
	const parts = ip.split(".").map(Number);
	if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
	const [a, b] = parts;
	if (a === 0) return true; // 0.0.0.0/8
	if (a === 10) return true; // 10.0.0.0/8 RFC1918
	if (a === 127) return true; // 127.0.0.0/8 loopback
	if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata)
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
	if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
	return false;
}

function isPrivateIPv6(ip: string): boolean {
	const lower = ip.toLowerCase();
	if (lower === "::" || lower === "::1") return true; // unspecified, loopback

	// IPv4-mapped IPv6 (::ffff:0:0/96). Two normalised forms:
	//   - dotted-quad:  ::ffff:127.0.0.1
	//   - compressed hex: ::ffff:7f00:1   (Node normalises to this form)
	const v4MappedDotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (v4MappedDotted) return isPrivateIPv4(v4MappedDotted[1]);
	const v4MappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
	if (v4MappedHex) {
		const high = Number.parseInt(v4MappedHex[1], 16);
		const low = Number.parseInt(v4MappedHex[2], 16);
		const dotted = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
		return isPrivateIPv4(dotted);
	}

	// fe80::/10 link-local (fe80–febf)
	if (/^fe[89ab]/.test(lower)) return true;
	// fc00::/7 unique-local (fc, fd)
	if (/^f[cd]/.test(lower)) return true;
	return false;
}

function isPrivateAddress(ip: string): boolean {
	if (isIPv4(ip)) return isPrivateIPv4(ip);
	if (isIPv6(ip)) return isPrivateIPv6(ip);
	return false;
}

/**
 * Reject URLs that point to loopback / private / link-local addresses,
 * resolving hostnames via DNS so indirection (`localtest.me`-style) cannot
 * bypass. Throws an Error with a descriptive message on rejection.
 *
 * The `signal` is checked at entry and again after DNS resolution. Note that
 * `dns.lookup` itself is not cancellable mid-flight in Node — a hostile DNS
 * resolver could stall up to its OS-level timeout. That is consistent with
 * the existing fetch-timeout envelope around this call.
 */
async function assertSafeUrl(url: URL, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw new Error(`Fetch aborted: ${url.href}`);

	// `URL.hostname` returns IPv6 literals wrapped in `[...]`; strip for parsing.
	const rawHost = url.hostname;
	const host =
		rawHost.startsWith("[") && rawHost.endsWith("]")
			? rawHost.slice(1, -1)
			: rawHost;

	if (isIP(host)) {
		if (isPrivateAddress(host)) {
			throw new Error(
				`Refusing to fetch private/loopback address: ${url.href}`,
			);
		}
		return;
	}

	let addresses: { address: string; family: number }[];
	try {
		addresses = await lookup(host, { all: true });
	} catch (err) {
		throw new Error(
			`DNS lookup failed for ${host}: ${err instanceof Error ? err.message : err}`,
		);
	}

	if (signal?.aborted) throw new Error(`Fetch aborted: ${url.href}`);

	for (const addr of addresses) {
		if (isPrivateAddress(addr.address)) {
			throw new Error(
				`Refusing to fetch ${url.href} — hostname ${host} resolves to private/loopback address ${addr.address}`,
			);
		}
	}
}

/** Exported for tests. */
export const __ssrf = { isPrivateAddress, assertSafeUrl };

// Simple TTL cache with FIFO eviction: url → { result, timestamp }
const cache = new Map<string, { result: FetchResult; ts: number }>();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_CACHE_ENTRIES = 50;

function evictStaleEntries(): void {
	const now = Date.now();
	for (const [key, entry] of cache) {
		if (now - entry.ts > CACHE_TTL_MS) cache.delete(key);
	}
	// If still over limit, drop oldest
	while (cache.size > MAX_CACHE_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
}

/**
 * Convert HTML to markdown using Turndown.
 *
 * Strips script/style/nav/header/footer elements before conversion
 * to reduce noise and focus on main content.
 */
export function htmlToMarkdown(html: string): string {
	const td = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
	});

	// Remove non-content elements
	td.remove(["script", "style", "nav", "footer", "header", "aside", "iframe", "noscript"]);

	return td.turndown(html);
}

/**
 * Fetch a URL and return its content, converting HTML to markdown.
 *
 * - HTML responses are converted to markdown via Turndown
 * - JSON responses are returned as formatted JSON
 * - Other text responses are returned as-is
 * - Content is truncated to 100K chars (matching Claude Code)
 * - Results are cached with 15-minute TTL
 */
export async function fetchUrl(
	url: string,
	signal?: AbortSignal,
): Promise<FetchResult> {
	// Validate URL
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Invalid URL: ${url}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Only HTTP/HTTPS URLs are supported: ${url}`);
	}

	// Set up the abort + timeout envelope FIRST so that everything below —
	// the early SSRF DNS lookup, cache eviction, the redirect loop — is
	// covered. Attaching the listener after assertSafeUrl would leave a
	// window where an external abort fires after DNS resolves but before
	// fetch starts, leaving the inner fetch unaware of the cancel.
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	let removeSignalListener: (() => void) | undefined;
	if (signal) {
		const handler = () => controller.abort();
		signal.addEventListener("abort", handler, { once: true });
		removeSignalListener = () => signal.removeEventListener("abort", handler);
	}

	// Manual redirect following: `fetch`'s built-in `redirect: "follow"` would
	// silently chase a 302 from a public host into a private one (e.g.
	// 169.254.169.254), bypassing the SSRF guard. We follow redirects ourselves
	// and re-validate every hop.
	let response: Response;
	try {
		// SSRF guard — rejects loopback/private/link-local before any network
		// I/O. Per-hop validation also runs inside the redirect loop below; this
		// early check short-circuits cache lookups for obviously-bad URLs.
		await assertSafeUrl(parsed, signal);

		// Check cache
		evictStaleEntries();
		const cached = cache.get(url);
		if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
			clearTimeout(timeout);
			return cached.result;
		}

		let currentUrl = parsed;
		let redirectCount = 0;
		while (true) {
			let hop: Response;
			try {
				hop = await fetch(currentUrl.href, {
					signal: controller.signal,
					headers: {
						"Accept":
							"text/markdown, text/html, application/json, text/plain, */*",
						"User-Agent": "pi-code-intel/1.0 (coding agent)",
					},
					redirect: "manual",
				});
			} catch (err) {
				if (err instanceof DOMException && err.name === "AbortError") {
					if (signal?.aborted) {
						throw new Error(`Fetch aborted: ${url}`);
					}
					throw new Error(
						`Fetch timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`,
					);
				}
				throw new Error(
					`Fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			const isRedirect =
				hop.status === 301 ||
				hop.status === 302 ||
				hop.status === 303 ||
				hop.status === 307 ||
				hop.status === 308;

			if (!isRedirect) {
				response = hop;
				break;
			}

			const location = hop.headers.get("location");
			// Drain the redirect body so the underlying connection can be reused
			// or freed promptly. Errors from cancel are not actionable.
			try {
				await hop.body?.cancel();
			} catch {
				/* ignore */
			}

			if (!location) {
				throw new Error(
					`Redirect ${hop.status} from ${currentUrl.href} missing Location header`,
				);
			}
			if (++redirectCount > MAX_REDIRECTS) {
				throw new Error(
					`Too many redirects (> ${MAX_REDIRECTS}) starting at: ${url}`,
				);
			}

			let nextUrl: URL;
			try {
				nextUrl = new URL(location, currentUrl);
			} catch {
				throw new Error(
					`Invalid redirect Location from ${currentUrl.href}: ${location}`,
				);
			}
			if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
				throw new Error(
					`Refusing redirect to non-HTTP scheme: ${nextUrl.href}`,
				);
			}

			// Re-run the SSRF guard against the new target before issuing the
			// next fetch. This is the whole point of `redirect: "manual"`.
			await assertSafeUrl(nextUrl, signal);
			currentUrl = nextUrl;
		}
	} finally {
		removeSignalListener?.();
	}

	if (!response.ok) {
		clearTimeout(timeout);
		throw new Error(`HTTP ${response.status} ${response.statusText}: ${url}`);
	}

	// Stream body with size limit — abort the moment cumulative bytes exceed
	// MAX_RESPONSE_BYTES so we never buffer an unbounded response. The fetch
	// timeout remains active to protect against a server drip-feeding bytes.
	const contentType = response.headers.get("content-type") ?? "text/plain";
	const contentLength = response.headers.get("content-length");
	if (contentLength && Number.parseInt(contentLength) > MAX_RESPONSE_BYTES) {
		clearTimeout(timeout);
		throw new Error(`Response too large (${contentLength} bytes, max ${MAX_RESPONSE_BYTES}): ${url}`);
	}

	let rawText: string;
	try {
		if (!response.body) {
			rawText = "";
		} else {
			const chunks: Buffer[] = [];
			let total = 0;
			for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
				total += chunk.byteLength;
				if (total > MAX_RESPONSE_BYTES) {
					controller.abort();
					throw new Error(
						`Response too large (> ${MAX_RESPONSE_BYTES} bytes): ${url}`,
					);
				}
				chunks.push(Buffer.from(chunk));
			}
			rawText = Buffer.concat(chunks).toString("utf-8");
		}
	} finally {
		clearTimeout(timeout);
	}

	// Convert based on content type
	let content: string;
	if (contentType.includes("application/json")) {
		// JSON: pretty-print for readability
		try {
			content = JSON.stringify(JSON.parse(rawText), null, 2);
		} catch (parseErr) {
			console.error(
				`[code-intel] Response declared as JSON but failed to parse (${url}):`,
				parseErr instanceof Error ? parseErr.message : parseErr,
			);
			content = rawText;
		}
	} else if (contentType.includes("text/html")) {
		content = htmlToMarkdown(rawText);
	} else {
		// Plain text, markdown, etc.
		content = rawText;
	}

	// Truncate
	let truncated = false;
	if (content.length > MAX_CONTENT_LENGTH) {
		content = `${content.slice(0, MAX_CONTENT_LENGTH)}\n\n[Content truncated due to length...]`;
		truncated = true;
	}

	const result: FetchResult = { content, contentType, truncated };

	// Cache result
	cache.set(url, { result, ts: Date.now() });

	return result;
}

/** Clear the fetch cache. Exposed for testing. */
export function clearCache(): void {
	cache.clear();
}
