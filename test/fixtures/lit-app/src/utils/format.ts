/** Plain .ts helpers so the bundle/typecheck graph spans non-element modules too. */

export function formatCount(n: number): string {
	return n > 0 ? `+${n}` : String(n);
}

export function pluralize(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
