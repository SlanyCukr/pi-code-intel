import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:dns/promises BEFORE importing the module under test so the
// SSRF guard's `lookup` call is intercepted. Default behaviour: every
// hostname resolves to a non-private public IP. Individual tests can
// override via `mockLookup.mockResolvedValueOnce(...)`.
const mockLookup =
	vi.fn<
		(
			host: string,
			opts?: unknown,
		) => Promise<{ address: string; family: number }[]>
	>();
vi.mock("node:dns/promises", () => ({
	lookup: (host: string, opts?: unknown) => mockLookup(host, opts),
}));

const { fetchUrl, htmlToMarkdown, clearCache } = await import(
	"../../src/web/fetch.js"
);

// Mock global fetch
const mockFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", mockFetch);

function makeResponse(body: string, contentType = "text/html", status = 200): Response {
	return new Response(body, {
		status,
		headers: { "content-type": contentType },
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	clearCache();
	// Default: every hostname resolves to a public IP (passes SSRF check)
	mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

describe("htmlToMarkdown", () => {
	it("converts basic HTML to markdown", () => {
		const html = "<h1>Title</h1><p>Hello <strong>world</strong></p>";
		const md = htmlToMarkdown(html);
		expect(md).toContain("Title");
		expect(md).toContain("**world**");
	});

	it("strips script and style elements", () => {
		const html = `
			<script>alert('xss')</script>
			<style>.foo { color: red; }</style>
			<p>Content here</p>
		`;
		const md = htmlToMarkdown(html);
		expect(md).not.toContain("alert");
		expect(md).not.toContain("color");
		expect(md).toContain("Content here");
	});

	it("strips nav, footer, header, aside elements", () => {
		const html = `
			<nav><a href="/">Home</a></nav>
			<header>Site Header</header>
			<main><p>Main content</p></main>
			<aside>Sidebar</aside>
			<footer>Copyright</footer>
		`;
		const md = htmlToMarkdown(html);
		expect(md).toContain("Main content");
		expect(md).not.toContain("Site Header");
		expect(md).not.toContain("Copyright");
	});

	it("preserves code blocks", () => {
		const html = "<pre><code>const x = 1;</code></pre>";
		const md = htmlToMarkdown(html);
		expect(md).toContain("const x = 1;");
	});
});

describe("fetchUrl", () => {
	it("fetches and converts HTML to markdown", async () => {
		mockFetch.mockResolvedValueOnce(
			makeResponse("<h1>Docs</h1><p>Hello</p>", "text/html"),
		);

		const result = await fetchUrl("https://example.com/docs");

		expect(result.contentType).toBe("text/html");
		expect(result.content).toContain("Docs");
		expect(result.content).toContain("Hello");
		expect(result.truncated).toBe(false);
	});

	it("returns JSON as pretty-printed text", async () => {
		mockFetch.mockResolvedValueOnce(
			makeResponse('{"key":"value"}', "application/json"),
		);

		const result = await fetchUrl("https://api.example.com/data");

		expect(result.contentType).toBe("application/json");
		expect(result.content).toContain('"key": "value"');
	});

	it("returns plain text as-is", async () => {
		mockFetch.mockResolvedValueOnce(
			makeResponse("plain text content", "text/plain"),
		);

		const result = await fetchUrl("https://example.com/readme.txt");

		expect(result.content).toBe("plain text content");
	});

	it("truncates large content", async () => {
		const largeContent = "x".repeat(150_000);
		mockFetch.mockResolvedValueOnce(
			makeResponse(largeContent, "text/plain"),
		);

		const result = await fetchUrl("https://example.com/large");

		expect(result.truncated).toBe(true);
		expect(result.content.length).toBeLessThan(150_000);
		expect(result.content).toContain("[Content truncated due to length...]");
	});

	it("caches results for the same URL", async () => {
		mockFetch.mockResolvedValueOnce(
			makeResponse("<p>cached</p>", "text/html"),
		);

		await fetchUrl("https://example.com/cached");
		await fetchUrl("https://example.com/cached");

		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("rejects invalid URLs", async () => {
		await expect(fetchUrl("not-a-url")).rejects.toThrow("Invalid URL");
	});

	it("rejects non-HTTP URLs", async () => {
		await expect(fetchUrl("ftp://example.com")).rejects.toThrow("Only HTTP/HTTPS");
	});

	it("throws on HTTP errors", async () => {
		mockFetch.mockResolvedValueOnce(
			makeResponse("Not Found", "text/plain", 404),
		);

		await expect(fetchUrl("https://example.com/404")).rejects.toThrow("HTTP 404");
	});

	it("throws on fetch failure", async () => {
		mockFetch.mockRejectedValueOnce(new Error("Network error"));

		await expect(fetchUrl("https://example.com/fail")).rejects.toThrow("Fetch failed");
	});

	it("throws on timeout (AbortError)", async () => {
		const abortError = new DOMException("The operation was aborted", "AbortError");
		mockFetch.mockRejectedValueOnce(abortError);

		await expect(fetchUrl("https://example.com/slow")).rejects.toThrow("Fetch timed out");
	});

	it("distinguishes external abort from timeout", async () => {
		const controller = new AbortController();
		controller.abort();

		const abortError = new DOMException("The operation was aborted", "AbortError");
		mockFetch.mockRejectedValueOnce(abortError);

		await expect(fetchUrl("https://example.com/cancel", controller.signal)).rejects.toThrow("Fetch aborted");
	});

	it("throws on oversized Content-Length header", async () => {
		const response = new Response("small", {
			status: 200,
			headers: {
				"content-type": "text/plain",
				"content-length": String(20 * 1024 * 1024),
			},
		});
		mockFetch.mockResolvedValueOnce(response);

		await expect(fetchUrl("https://example.com/huge")).rejects.toThrow("Response too large");
	});

	it("throws on oversized body when Content-Length header is absent", async () => {
		// No Content-Length, body streams chunked beyond MAX_RESPONSE_BYTES.
		// Build a real ReadableStream so the streaming size guard kicks in
		// chunk-by-chunk rather than after a full buffer read.
		const CHUNK = 1 * 1024 * 1024;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < 12; i++) {
					controller.enqueue(new Uint8Array(CHUNK).fill(0x78)); // 'x'
				}
				controller.close();
			},
		});
		const response = new Response(stream, {
			status: 200,
			headers: { "content-type": "text/plain" },
		});
		mockFetch.mockResolvedValueOnce(response);

		await expect(fetchUrl("https://example.com/chunked-huge")).rejects.toThrow(
			"Response too large",
		);
	});

	// -- SSRF guard --

	it("rejects literal loopback IP", async () => {
		await expect(fetchUrl("http://127.0.0.1/admin")).rejects.toThrow(
			/private\/loopback/,
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("rejects literal RFC1918 address", async () => {
		await expect(fetchUrl("http://10.0.0.5/")).rejects.toThrow(
			/private\/loopback/,
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("rejects cloud-metadata link-local IP", async () => {
		await expect(
			fetchUrl("http://169.254.169.254/latest/meta-data/"),
		).rejects.toThrow(/private\/loopback/);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("rejects IPv6 loopback", async () => {
		await expect(fetchUrl("http://[::1]/")).rejects.toThrow(
			/private\/loopback/,
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("rejects IPv4-mapped IPv6 loopback", async () => {
		await expect(fetchUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow(
			/private\/loopback/,
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("rejects hostname that resolves to a private address", async () => {
		mockLookup.mockResolvedValueOnce([
			{ address: "127.0.0.1", family: 4 },
		]);
		await expect(
			fetchUrl("http://localtest.example.com/"),
		).rejects.toThrow(/resolves to private\/loopback/);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("rejects when ANY resolved address is private (multi-A-record bypass)", async () => {
		mockLookup.mockResolvedValueOnce([
			{ address: "93.184.216.34", family: 4 },
			{ address: "169.254.169.254", family: 4 },
		]);
		await expect(
			fetchUrl("http://multi.example.com/"),
		).rejects.toThrow(/resolves to private\/loopback/);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("rejects redirect to a private IP (literal Location)", async () => {
		// Initial fetch returns 302 → 169.254.169.254. The fetch client must
		// re-validate the redirect target via the SSRF guard rather than
		// silently following.
		mockFetch.mockResolvedValueOnce(
			new Response(null, {
				status: 302,
				headers: { location: "http://169.254.169.254/latest/meta-data/" },
			}),
		);

		await expect(fetchUrl("https://example.com/redir")).rejects.toThrow(
			/private\/loopback/,
		);
		// First hop fetched, second hop refused before any further fetch.
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("rejects redirect to a hostname that resolves to a private IP", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(null, {
				status: 301,
				headers: { location: "http://internal.example.com/secret" },
			}),
		);
		// First hop hostname resolves public; redirect target resolves private.
		mockLookup.mockResolvedValueOnce([
			{ address: "93.184.216.34", family: 4 },
		]);
		mockLookup.mockResolvedValueOnce([
			{ address: "10.0.0.5", family: 4 },
		]);

		await expect(fetchUrl("https://public.example.com/r")).rejects.toThrow(
			/resolves to private\/loopback/,
		);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("follows safe redirects across hops", async () => {
		mockFetch
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "https://example.com/step2" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "https://example.com/final" },
				}),
			)
			.mockResolvedValueOnce(makeResponse("<p>landed</p>", "text/html"));

		const result = await fetchUrl("https://example.com/start");
		expect(result.content).toContain("landed");
		expect(mockFetch).toHaveBeenCalledTimes(3);
	});

	it("caps the number of redirect hops", async () => {
		// 11 redirects > MAX_REDIRECTS (10)
		for (let i = 0; i < 11; i++) {
			mockFetch.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: `https://example.com/hop${i + 1}` },
				}),
			);
		}

		await expect(fetchUrl("https://example.com/loop")).rejects.toThrow(
			/Too many redirects/,
		);
	});

	it("rejects redirect to a non-HTTP scheme", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(null, {
				status: 302,
				headers: { location: "file:///etc/passwd" },
			}),
		);

		await expect(fetchUrl("https://example.com/redir")).rejects.toThrow(
			/non-HTTP scheme/,
		);
	});

	it("rejects redirect with missing Location header", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(null, { status: 302 }),
		);

		await expect(fetchUrl("https://example.com/redir")).rejects.toThrow(
			/missing Location header/,
		);
	});

	it("surfaces DNS lookup failures", async () => {
		mockLookup.mockRejectedValueOnce(
			new Error("getaddrinfo ENOTFOUND nope.invalid"),
		);
		await expect(fetchUrl("http://nope.invalid/")).rejects.toThrow(
			/DNS lookup failed/,
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("returns raw text when JSON content-type but body is invalid JSON", async () => {
		mockFetch.mockResolvedValueOnce(
			makeResponse("not valid json {{{", "application/json"),
		);

		const result = await fetchUrl("https://api.example.com/broken");

		expect(result.contentType).toBe("application/json");
		expect(result.content).toBe("not valid json {{{");
	});
});
