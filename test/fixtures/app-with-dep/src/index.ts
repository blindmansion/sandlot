import isNumber from "is-number";
import { double } from "./math";

/** Mixes a real installed dependency (`is-number`) with a local module. */
export function check(value: unknown): string {
	const ok = isNumber(value);
	console.log("check", value, "->", ok);
	return ok ? `number: ${double(Number(value))}` : "not a number";
}
