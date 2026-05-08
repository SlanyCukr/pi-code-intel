import { describe, it, expect, beforeEach } from "vitest";
import {
	extractSymbolPattern,
	grepForSymbol,
} from "../../../src/analysis/patterns/grep-for-symbol.js";
import { makeSession, resetLineCounter, tcBash } from "./helpers.js";

describe("extractSymbolPattern", () => {
	const positives: Array<[string, string]> = [
		["grep foo src/", "foo"],
		["rg myFunction", "myFunction"],
		["grep -rn assertSafeUrl", "assertSafeUrl"],
		["grep -e my_symbol src/", "my_symbol"],
		["grep '^assertSafeUrl' src/", "assertSafeUrl"], // anchor stripped
		["rg --include '*.ts' fooBar src/", "fooBar"],
		["grep -i Camel src/", "Camel"],
		["egrep \"^ident$\" .", "ident"], // both anchors stripped
	];
	for (const [cmd, expected] of positives) {
		it(`extracts \`${expected}\` from: ${cmd}`, () => {
			expect(extractSymbolPattern(cmd)).toBe(expected);
		});
	}

	const negatives = [
		"git status",
		"grep 'foo|bar' src/",     // alternation = regex, not symbol
		"grep f.o src/",            // metachar
		"grep '*' src/",            // glob
		"grep",
		"",
		"cat file | grep foo",      // pipeline doesn't start with grep
		"rg",
		"grep -rn",                 // no pattern arg
	];
	for (const cmd of negatives) {
		it(`returns null for: ${JSON.stringify(cmd)}`, () => {
			expect(extractSymbolPattern(cmd)).toBeNull();
		});
	}
});

describe("grepForSymbol", () => {
	beforeEach(() => resetLineCounter());

	it("flags grep with bare-identifier pattern", () => {
		const hits = grepForSymbol(makeSession([tcBash("grep -rn assertSafeUrl src/")]));
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({
			ruleId: "grep-for-symbol",
			lineRange: [2, 2],
		});
		expect(hits[0].message).toContain("assertSafeUrl");
	});

	it("does not flag grep with regex pattern", () => {
		const hits = grepForSymbol(
			makeSession([tcBash("grep 'foo|bar' src/")]),
		);
		expect(hits).toEqual([]);
	});

	it("does not flag non-bash tool calls", () => {
		const hits = grepForSymbol(makeSession([
			{
				kind: "tool_call",
				entryId: "e1",
				lineNumber: 2,
				timestamp: "t",
				toolCallId: "tc1",
				name: "read",
				arguments: { path: "x" },
			},
		]));
		expect(hits).toEqual([]);
	});

	it("flags multiple grep-for-symbol calls in one session", () => {
		const hits = grepForSymbol(
			makeSession([
				tcBash("rg foo src/"),
				tcBash("npm test"),
				tcBash("grep -i bar ."),
			]),
		);
		expect(hits.map((h) => h.lineRange)).toEqual([
			[2, 2],
			[4, 4],
		]);
	});
});
