import { describe, it, expect, beforeEach } from "vitest";
import { editFailureThenReread } from "../../../src/analysis/patterns/edit-failure-then-reread.js";
import {
	makeSession,
	resetLineCounter,
	tcEdit,
	tcRead,
	trResult,
} from "./helpers.js";

describe("editFailureThenReread", () => {
	beforeEach(() => resetLineCounter());

	it("flags failed edit followed by re-read of same file", () => {
		const editEvent = tcEdit("src/x.ts", "tc-edit-1");
		const hits = editFailureThenReread(
			makeSession([
				editEvent,
				trResult("tc-edit-1", "edit", true),
				tcRead("src/x.ts"),
			]),
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].ruleId).toBe("edit-failure-then-reread");
	});

	it("does NOT flag a successful edit even if read follows", () => {
		const hits = editFailureThenReread(
			makeSession([
				tcEdit("src/x.ts", "tc-1"),
				trResult("tc-1", "edit", false),
				tcRead("src/x.ts"),
			]),
		);
		expect(hits).toEqual([]);
	});

	it("does NOT flag failed edit when next action on path is another edit (retry without re-read)", () => {
		const hits = editFailureThenReread(
			makeSession([
				tcEdit("src/x.ts", "tc-1"),
				trResult("tc-1", "edit", true),
				tcEdit("src/x.ts", "tc-2"), // direct retry — different pattern
			]),
		);
		expect(hits).toEqual([]);
	});

	it("only fires for re-read of the SAME file", () => {
		const hits = editFailureThenReread(
			makeSession([
				tcEdit("src/x.ts", "tc-1"),
				trResult("tc-1", "edit", true),
				tcRead("src/y.ts"), // unrelated file
			]),
		);
		expect(hits).toEqual([]);
	});

	it("does not flag when failed edit has no matching tool_result (orphan call)", () => {
		const hits = editFailureThenReread(
			makeSession([
				tcEdit("src/x.ts", "tc-orphan"),
				tcRead("src/x.ts"),
			]),
		);
		expect(hits).toEqual([]);
	});

	it("can produce multiple hits across the session", () => {
		const hits = editFailureThenReread(
			makeSession([
				tcEdit("a.ts", "tc-1"),
				trResult("tc-1", "edit", true),
				tcRead("a.ts"),
				tcEdit("b.ts", "tc-2"),
				trResult("tc-2", "edit", true),
				tcRead("b.ts"),
			]),
		);
		expect(hits).toHaveLength(2);
	});
});
