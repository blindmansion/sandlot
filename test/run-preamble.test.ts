/**
 * Codegen-level tests for the guest (worker) preamble.
 *
 * `generateGuestPreamble` is a pure function that returns the JavaScript string
 * run inside the sandbox Worker. These tests assert the generated source wires
 * up the exec machinery without needing a real Worker or postMessage boundary
 * (the end-to-end behavior is exercised by the browser sandbox harness).
 */

import { expect, test } from "bun:test";
import { defineHostFunction } from "../src/run/types";
import { generateGuestPreamble } from "../src/run/guest-preamble";

test("preamble runs exec code via eval with a sourceURL", () => {
	const src = generateGuestPreamble([]);

	// Named function expression evaluated via indirect eval (not new Function),
	// so the worker frame is attributed to sandlot://run.js.
	expect(src).toContain("const __fn = (0, eval)(__src);");
	expect(src).toContain('"(async function (" + paramNames.join(",") + ") {');
	expect(src).toContain("//# sourceURL=sandlot://run.js");
	// The Phase-A change drops the bundle's (now-misaligned) inline map comment.
	expect(src).toContain("sourceMappingURL");
	// new Function is gone from the exec path.
	expect(src).not.toContain("new Function(");
});

test("preamble reports the error stack on a failed exec", () => {
	const src = generateGuestPreamble([]);

	expect(src).toContain('if (msg.type === "exec")');
	expect(src).toContain("stack: err instanceof Error ? err.stack : undefined,");
	expect(src).toContain('postMessage({ type: "done", ok: !error, error: error });');
});

test("host function stubs are still generated alongside exec", () => {
	const fns = [
		defineHostFunction({
			path: ["Sand", "fs", "readFile"],
			fn: (_path: string) => "",
			dts: "(path: string) => string",
		}),
	];
	const src = generateGuestPreamble(fns);

	expect(src).toContain("__globals");
	expect(src).toContain("__stub_Sand_fs_readFile");
});
