/**
 * Shared utilities for RunFn implementations.
 */

import { joinOutputLines } from "./cli-output";
import type { HostFunction, LogEntry, LogLevel, RunCodeResult } from "./types";

const STDOUT_LEVELS: LogLevel[] = ["log", "info", "debug"];
const STDERR_LEVELS: LogLevel[] = ["warn", "error"];

/**
 * Build a {@link RunCodeResult} from a log and exit code.
 *
 * Splits log entries into stdout (log/info/debug) and stderr (warn/error).
 */
export function buildResult(log: LogEntry[], exitCode: number): RunCodeResult {
	const stdout = joinOutputLines(
		log.filter((e) => STDOUT_LEVELS.includes(e.level)).map((e) => e.text),
	);
	const stderr = joinOutputLines(
		log.filter((e) => STDERR_LEVELS.includes(e.level)).map((e) => e.text),
	);

	return { exitCode, stdout, stderr, log };
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
