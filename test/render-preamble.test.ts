/**
 * Codegen-level tests for the iframe render preamble.
 *
 * `generateIframePreamble` is a pure function that returns the JavaScript
 * string injected into the render iframe. These tests assert the generated
 * source contains the `evaluate` machinery without needing a DOM, iframe, or
 * postMessage boundary (the end-to-end behavior is exercised by the browser
 * smoke harness in `test/browser/app.ts`).
 */

import { expect, test } from "bun:test";
import { defineHostFunction } from "../src/run/types";
import { generateIframePreamble } from "../src/render/iframe-preamble";

const CHANNEL = "__test_channel";

test("preamble emits the __evaluate helper and eval message branch", () => {
	const src = generateIframePreamble([], CHANNEL);

	expect(src).toContain("async function __evaluate(code, args)");
	expect(src).toContain('if (msg.type === "eval")');
	expect(src).toContain('type: "eval-result"');
});

test("__evaluate binds __args and returns the IIFE value", () => {
	const src = generateIframePreamble([], CHANNEL);

	// __args is wired into the Function parameter list.
	expect(src).toContain('"module", "exports", "__args"');
	// The evaluate helper returns its value (unlike __execute, which awaits).
	expect(src).toContain("return await __fn(...paramValues);");
});

test("eval handling is present even with no host functions", () => {
	// No RPC stubs at all — the eval branch must still be emitted (it is not
	// gated on `hasRpcStubs`, unlike the host-response handler).
	const src = generateIframePreamble([], CHANNEL);

	expect(src).toContain('if (msg.type === "eval")');
	expect(src).not.toContain('if (msg.type === "host-response")');
});

test("non-serializable results fall back to a DataCloneError", () => {
	const src = generateIframePreamble([], CHANNEL);

	expect(src).toContain("Result is not serializable");
	expect(src).toContain('name: "DataCloneError"');
});

test("host function stubs are still generated alongside eval", () => {
	const fns = [
		defineHostFunction({
			path: ["Sand", "fs", "readFile"],
			fn: (_path: string) => "",
			dts: "(path: string) => string",
		}),
	];
	const src = generateIframePreamble(fns, CHANNEL);

	// Regression: adding eval must not break host-call stub codegen.
	expect(src).toContain('"Sand.fs.readFile"');
	expect(src).toContain('if (msg.type === "eval")');
	expect(src).toContain('if (msg.type === "host-response")');
});
