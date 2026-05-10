import { describe, it, expect, beforeEach } from "vitest";
import { bashCatOrHeadOrTail } from "../../../src/analysis/patterns/bash-cat-or-head-or-tail.js";
import { makeSession, resetLineCounter, tcBash } from "./helpers.js";

describe("bashCatOrHeadOrTail", () => {
	beforeEach(() => resetLineCounter());

	const positives = [
		"cat file.txt",
		"cat -n file.txt",
		"gcat file.txt",
		"head file.txt",
		"head -n 20 file.txt",
		"head -20 file.txt",
		"tail file.txt",
		"tail -n 50 file.txt",
		"tail -50 file.txt",
		"less file.txt",
		"more file.txt",
		"bat file.txt",
		"cd /tmp && cat file.txt", // dump after a cd is still a dump
	];
	for (const cmd of positives) {
		it(`flags: ${cmd}`, () => {
			const hits = bashCatOrHeadOrTail(makeSession([tcBash(cmd)]));
			expect(hits).toHaveLength(1);
			expect(hits[0].ruleId).toBe("bash-cat-or-head-or-tail");
		});
	}

	const negatives = [
		"cat file.txt | grep foo", // pipe → cat is feeding grep, not "viewing"
		"cat foo > bar", // redirect → copying, not reading
		"cat <<EOF\nhello\nEOF", // heredoc, not a file read
		"tail -f /var/log/app.log", // log monitoring, not inspection
		"tail --follow /var/log/app.log",
		"head -c 100 /dev/urandom | od -An", // pipe
		"echo hello", // unrelated
		"git status",
		"npm test",
		"ls", // directory listing, not file dump
	];
	for (const cmd of negatives) {
		it(`does not flag: ${cmd}`, () => {
			const hits = bashCatOrHeadOrTail(makeSession([tcBash(cmd)]));
			expect(hits).toEqual([]);
		});
	}

	it("emits one hit per matching command across multiple commands", () => {
		const hits = bashCatOrHeadOrTail(
			makeSession([
				tcBash("cat a.txt"),
				tcBash("npm test"),
				tcBash("head -n 10 b.txt"),
				tcBash("tail -f /var/log/c.log"), // skipped (follow mode)
			]),
		);
		expect(hits.map((h) => h.lineRange)).toEqual([
			[2, 2],
			[4, 4],
		]);
	});
});
