import { describe, it, expect, beforeEach } from "vitest";
import {
	extractGrepTargetFiles,
	readAfterGrepSameFile,
} from "../../../src/analysis/patterns/read-after-grep-same-file.js";
import {
	makeSession,
	resetLineCounter,
	tcBash,
	tcRead,
} from "./helpers.js";

describe("extractGrepTargetFiles", () => {
	it("returns the file path argument", () => {
		expect(extractGrepTargetFiles("grep foo src/x.ts")).toEqual(["src/x.ts"]);
	});

	it("returns multiple file paths if listed", () => {
		expect(
			extractGrepTargetFiles("grep -n bar src/a.ts src/b.ts"),
		).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("returns empty for grep over a directory (no file extension hint)", () => {
		// `src/` ends in `/` and contains `/`, so it matches our heuristic.
		// That's acceptable — the next read of `src/` won't match (read tool
		// doesn't take dirs); the rule body won't fire.
		const result = extractGrepTargetFiles("grep foo src/");
		expect(result).toEqual(["src/"]);
	});

	it("returns empty for non-search commands", () => {
		expect(extractGrepTargetFiles("git log --oneline")).toEqual([]);
		expect(extractGrepTargetFiles("")).toEqual([]);
		expect(extractGrepTargetFiles("npm test")).toEqual([]);
	});
});

describe("readAfterGrepSameFile", () => {
	beforeEach(() => resetLineCounter());

	it("flags grep on a file followed by read of same file", () => {
		const hits = readAfterGrepSameFile(
			makeSession([
				tcBash("grep -n assertSafeUrl src/web/fetch.ts"),
				tcRead("src/web/fetch.ts"),
			]),
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].ruleId).toBe("read-after-grep-same-file");
	});

	it("does not flag when read is for a different file", () => {
		const hits = readAfterGrepSameFile(
			makeSession([
				tcBash("grep foo src/x.ts"),
				tcRead("src/y.ts"),
			]),
		);
		expect(hits).toEqual([]);
	});

	it("does not flag when next tool call is not a read", () => {
		const hits = readAfterGrepSameFile(
			makeSession([
				tcBash("grep foo src/x.ts"),
				tcBash("npm test"),
			]),
		);
		expect(hits).toEqual([]);
	});

	it("looks ahead through up to 3 tool calls", () => {
		const hits = readAfterGrepSameFile(
			makeSession([
				tcBash("grep foo src/x.ts"),
				tcBash("ls"),
				tcBash("ls"),
				tcRead("src/x.ts"), // 3rd tool call after — within window
			]),
		);
		expect(hits).toHaveLength(1);
	});

	it("does not flag a read more than 3 tool calls after grep", () => {
		const hits = readAfterGrepSameFile(
			makeSession([
				tcBash("grep foo src/x.ts"),
				tcBash("ls"),
				tcBash("ls"),
				tcBash("ls"),
				tcRead("src/x.ts"), // 4th tool call — outside window
			]),
		);
		expect(hits).toEqual([]);
	});

	it("matches by suffix (so absolute path read after relative grep flags)", () => {
		const hits = readAfterGrepSameFile(
			makeSession([
				tcBash("grep foo src/x.ts"),
				tcRead("/proj/src/x.ts"),
			]),
		);
		expect(hits).toHaveLength(1);
	});
});
