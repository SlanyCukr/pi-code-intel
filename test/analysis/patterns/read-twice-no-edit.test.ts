import { describe, it, expect, beforeEach } from "vitest";
import { readTwiceNoEdit } from "../../../src/analysis/patterns/read-twice-no-edit.js";
import {
	makeSession,
	resetLineCounter,
	tcEdit,
	tcRead,
	tcWrite,
} from "./helpers.js";

describe("readTwiceNoEdit", () => {
	beforeEach(() => resetLineCounter());

	it("does not flag a single read", () => {
		const hits = readTwiceNoEdit(makeSession([tcRead("src/x.ts")]));
		expect(hits).toEqual([]);
	});

	it("flags a second read of the same path with no edit between", () => {
		const hits = readTwiceNoEdit(
			makeSession([tcRead("src/x.ts"), tcRead("src/x.ts")]),
		);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({
			ruleId: "read-twice-no-edit",
			lineRange: [2, 3],
		});
	});

	it("does NOT flag when the path was edited between reads", () => {
		const hits = readTwiceNoEdit(
			makeSession([
				tcRead("src/x.ts"),
				tcEdit("src/x.ts"),
				tcRead("src/x.ts"),
			]),
		);
		expect(hits).toEqual([]);
	});

	it("does NOT flag when the path was written between reads", () => {
		const hits = readTwiceNoEdit(
			makeSession([
				tcRead("src/x.ts"),
				tcWrite("src/x.ts"),
				tcRead("src/x.ts"),
			]),
		);
		expect(hits).toEqual([]);
	});

	it("flags subsequent reads independently per path", () => {
		const hits = readTwiceNoEdit(
			makeSession([
				tcRead("a.ts"),
				tcRead("b.ts"),
				tcRead("a.ts"), // re-reads a.ts — flagged
				tcRead("b.ts"), // re-reads b.ts — flagged
			]),
		);
		expect(hits).toHaveLength(2);
		expect(hits.map((h) => h.lineRange)).toEqual([
			[2, 4],
			[3, 5],
		]);
	});

	it("flags every additional read after the first when never edited", () => {
		const hits = readTwiceNoEdit(
			makeSession([tcRead("x.ts"), tcRead("x.ts"), tcRead("x.ts")]),
		);
		// reads at lines 2, 3, 4 — flag (2,3) and (3,4)
		expect(hits.map((h) => h.lineRange)).toEqual([
			[2, 3],
			[3, 4],
		]);
	});

	it("does not flag when path arg is missing", () => {
		const hits = readTwiceNoEdit(
			makeSession([
				{
					kind: "tool_call",
					entryId: "e1",
					lineNumber: 2,
					timestamp: "t",
					toolCallId: "tc1",
					name: "read",
					arguments: {}, // no path
				},
				{
					kind: "tool_call",
					entryId: "e2",
					lineNumber: 3,
					timestamp: "t",
					toolCallId: "tc2",
					name: "read",
					arguments: {},
				},
			]),
		);
		expect(hits).toEqual([]);
	});

	it("treats different exact path strings as different files (no normalization)", () => {
		const hits = readTwiceNoEdit(
			makeSession([tcRead("./src/x.ts"), tcRead("src/x.ts")]),
		);
		expect(hits).toEqual([]);
	});
});
