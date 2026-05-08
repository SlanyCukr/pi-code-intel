import { describe, it, expect, beforeEach } from "vitest";
import { bashSedOrAwkEdit } from "../../../src/analysis/patterns/bash-sed-or-awk-edit.js";
import { makeSession, resetLineCounter, tcBash } from "./helpers.js";

describe("bashSedOrAwkEdit", () => {
	beforeEach(() => resetLineCounter());

	const positives = [
		"sed -i 's/foo/bar/' file.txt",
		"sed -E -i 's/x/y/g' file.txt",
		"sed -i.bak 's/foo/bar/' file.txt",
		"sed -i '' 's/foo/bar/' file.txt", // BSD form
		"gsed -i 's/x/y/' file.txt",
		"perl -i -pe 's/foo/bar/' file.txt",
		"perl -i.bak -pe 's/x/y/' file.txt",
		"awk '{print $1}' input > output.txt",
		"awk '/foo/' input >> log.txt",
	];
	for (const cmd of positives) {
		it(`flags: ${cmd}`, () => {
			const hits = bashSedOrAwkEdit(makeSession([tcBash(cmd)]));
			expect(hits).toHaveLength(1);
			expect(hits[0].ruleId).toBe("bash-sed-or-awk-edit");
		});
	}

	const negatives = [
		"sed 's/foo/bar/' file.txt",        // no -i, just printing to stdout
		"awk '{print $1}' file.txt",         // no redirect — output to stdout
		"echo hello > file.txt",             // file creation, not editing
		"cat file.txt | sed 's/x/y/'",       // pipeline, no -i
		"perl -e 'print 42'",                // no -i flag
		"git status",
		"npm test",
	];
	for (const cmd of negatives) {
		it(`does not flag: ${cmd}`, () => {
			const hits = bashSedOrAwkEdit(makeSession([tcBash(cmd)]));
			expect(hits).toEqual([]);
		});
	}

	it("emits one hit per matching command even if multiple commands match", () => {
		const hits = bashSedOrAwkEdit(
			makeSession([
				tcBash("sed -i 's/foo/bar/' a.txt"),
				tcBash("npm test"),
				tcBash("perl -i -pe 's/x/y/' b.txt"),
			]),
		);
		expect(hits.map((h) => h.lineRange)).toEqual([
			[2, 2],
			[4, 4],
		]);
	});
});
