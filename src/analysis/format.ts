/**
 * Shared formatting helpers for analysis metrics.
 *
 * Both `report.ts` and `propose.ts` render ratio + percent metric values into
 * markdown; centralising the formatters here keeps "n/a when null" semantics
 * and decimal precision consistent across the two outputs.
 */

export function formatRatio(r: number | null): string {
	return r === null ? "n/a" : r.toFixed(2);
}

export function formatPercent(r: number | null): string {
	return r === null ? "n/a" : `${(r * 100).toFixed(1)}%`;
}
