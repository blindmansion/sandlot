/**
 * Test harness for executing bundled code produced by the bundle module.
 *
 * This is a thin wrapper over the library's native runner
 * ({@link createNativeRunFn}): it runs a **CommonJS** bundle (`format: "cjs"`)
 * in the host realm and returns both the module's exports and the captured
 * console log. The native runner is the same code path the library ships, so
 * tests exercise real behavior rather than a bespoke sandbox.
 *
 * It is not a security sandbox — it's for exercising trusted, test-authored
 * code. ESM bundles are not supported here because the native runner strips
 * `export { … }` blocks; bundle as CJS to read exports back.
 */

import { createNativeRunFn, type NativeRunResult } from "../../src/runtimes/native";
import type { HostFunction, LogEntry, RunError } from "../../src/run/types";

/** Result of executing a bundle. */
export interface RunResult<T = unknown> {
	/** The bundle's `module.exports` (CJS). */
	exports: T;
	/** Captured console output, in call order. */
	log: LogEntry[];
	/** True if the code ran to completion without throwing. */
	ok: boolean;
	/** The error that terminated execution, if any. */
	error?: RunError;
}

export interface RunOptions {
	/** Host functions to inject as globals (e.g. `Sand.fs.*`, custom stubs). */
	hostFunctions?: HostFunction[];
}

const nativeRun = createNativeRunFn();

/**
 * Execute a CommonJS bundle and return its exports plus captured console output.
 *
 * @example
 * ```ts
 * const { code } = await bundle({ ..., options: { format: "cjs" } });
 * const { exports, log } = await runBundle<{ main(): string }>(code);
 * expect(exports.main()).toBe("Hello, world!");
 * ```
 */
export async function runBundle<T = unknown>(
	code: string,
	options: RunOptions = {},
): Promise<RunResult<T>> {
	const result: NativeRunResult = await nativeRun({
		code,
		hostFunctions: options.hostFunctions,
	});

	return {
		exports: result.exports as T,
		log: result.log,
		ok: result.ok,
		error: result.error,
	};
}
