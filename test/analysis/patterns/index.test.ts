import { describe, it, expect, beforeEach } from "vitest";
import { RULES, runAllRules } from "../../../src/analysis/patterns/index.js";
import {
	makeSession,
	resetLineCounter,
	tcBash,
	tcEdit,
	tcRead,
	trResult,
} from "./helpers.js";

describe("rule registry", () => {
	it("registers all six rules", () => {
		expect(RULES).toHaveLength(6);
	});
});

describe("runAllRules", () => {
	beforeEach(() => resetLineCounter());

	it("returns empty for a clean session", () => {
		const hits = runAllRules(
			makeSession([tcRead("src/x.ts"), tcEdit("src/x.ts", "tc-1"), trResult("tc-1", "edit", false)]),
		);
		expect(hits).toEqual([]);
	});

	it("aggregates hits from multiple rules in the same session", () => {
		const hits = runAllRules(
			makeSession([
				tcRead("src/x.ts"),
				tcRead("src/x.ts"), // -> read-twice-no-edit
				tcBash("grep myFunc src/y.ts"), // -> grep-for-symbol AND maybe read-after-grep
				tcRead("src/y.ts"), // -> read-after-grep-same-file
			]),
		);
		const ruleIds = new Set(hits.map((h) => h.ruleId));
		expect(ruleIds.has("read-twice-no-edit")).toBe(true);
		expect(ruleIds.has("grep-for-symbol")).toBe(true);
		expect(ruleIds.has("read-after-grep-same-file")).toBe(true);
	});

	it("does not double-count: each rule emits independently", () => {
		// One offending grep + read produces hits from grep-for-symbol AND
		// read-after-grep-same-file — that's correct, not duplicate.
		const hits = runAllRules(
			makeSession([
				tcBash("grep myFunc src/y.ts"),
				tcRead("src/y.ts"),
			]),
		);
		const byRule: Record<string, number> = {};
		for (const h of hits) byRule[h.ruleId] = (byRule[h.ruleId] ?? 0) + 1;
		// Each rule fires at most once for these events.
		expect(byRule["grep-for-symbol"]).toBe(1);
		expect(byRule["read-after-grep-same-file"]).toBe(1);
	});
});
