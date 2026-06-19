/**
 * Shared utilities for RunFn implementations.
 */

import type { HostFunction, LogEntry, RunCodeResult, RunError } from "./types";

/**
 * Build a {@link RunCodeResult} from a captured log and an optional error.
 *
 * The presence of an `error` is what marks a run as failed — `ok` is derived
 * from it. Rendering the log into CLI streams is the formatting layer's job.
 */
export function buildResult(
	log: LogEntry[],
	error?: RunError,
): RunCodeResult {
	return { ok: !error, log, error };
}

/** Normalize an unknown thrown value into a structured {@link RunError}. */
export function toRunError(err: unknown): RunError {
	if (err instanceof Error) {
		return { message: err.message, name: err.name, stack: err.stack };
	}
	return { message: String(err) };
}

/**
 * Merge multiple host function lists, deduplicating by path.
 *
 * Later entries override earlier ones with the same dot-joined path,
 * so user-provided functions take precedence over defaults.
 */
export function mergeHostFunctions(...lists: HostFunction[][]): HostFunction[] {
	const byId = new Map<string, HostFunction>();
	for (const list of lists) {
		for (const hf of list) {
			byId.set(hf.path.join("."), hf);
		}
	}
	return Array.from(byId.values());
}

/**
 * Strip ESM `export { ... }` blocks from bundled code.
 *
 * esbuild's ESM output appends export declarations that are valid at
 * the module top level but cause SyntaxErrors inside eval-style runners
 * (`new Function()`, QuickJS `evalCode`, etc.). Since we only care about
 * side effects (console output, host calls), the exports are safely
 * discarded.
 */
export function stripModuleExports(code: string): string {
	return code.replace(/\bexport\s*\{[^}]*\}\s*;?/g, "");
}
