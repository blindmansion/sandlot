/**
 * Native RunFn implementation for main-thread execution.
 *
 * Executes bundled code via `new Function()` wrapped in an async IIFE,
 * which supports top-level `await` without requiring ES module loading.
 * Host functions are injected as function parameters — no globalThis
 * mutation needed. Console is provided as a host function, not a
 * special-cased parameter.
 */

import { createConsoleHostFunctions } from "../host-functions/console";
import { buildResult, mergeHostFunctions, stripModuleExports } from "../run/shared";
import type { HostFunction, LogEntry, RunCodeResult, RunFn } from "../run/types";

/**
 * Build a map of top-level global names to their values from a list of
 * host functions. Single-segment paths produce the function directly;
 * multi-segment paths build nested plain objects.
 *
 * Example:
 *   [{ path: ["fetch"], fn },
 *    { path: ["Sand", "fs", "readFile"], fn },
 *    { path: ["Sand", "fs", "writeFile"], fn }]
 *  →
 *   { fetch: fn, Sand: { fs: { readFile: fn, writeFile: fn } } }
 */
function buildGlobals(hostFunctions: HostFunction[]): Record<string, unknown> {
	const globals: Record<string, unknown> = {};

	for (const hf of hostFunctions) {
		const { path, fn } = hf;
		if (path.length === 0) continue;

		const root = path[0] as string;

		if (path.length === 1) {
			globals[root] = fn;
			continue;
		}

		if (!(root in globals) || typeof globals[root] !== "object") {
			globals[root] = {};
		}

		let current = globals[root] as Record<string, unknown>;
		for (let i = 1; i < path.length - 1; i++) {
			const segment = path[i] as string;
			if (!(segment in current) || typeof current[segment] !== "object") {
				current[segment] = {};
			}
			current = current[segment] as Record<string, unknown>;
		}

		const leaf = path[path.length - 1] as string;
		current[leaf] = fn;
	}

	return globals;
}

/**
 * Execute bundled code in an async IIFE via `new Function()`.
 *
 * The async wrapper enables top-level `await` regardless of whether
 * the code was bundled as ESM or CJS. Host functions (including console)
 * are injected as function parameters for clean isolation.
 */
async function execute(
	code: string,
	globals: Record<string, unknown>,
): Promise<void> {
	const module = { exports: {} };

	const paramNames = ["module", "exports"];
	const paramValues: unknown[] = [module, module.exports];

	for (const [name, value] of Object.entries(globals)) {
		paramNames.push(name);
		paramValues.push(value);
	}

	const fn = new Function(
		...paramNames,
		`return (async () => {\n${stripModuleExports(code)}\n})();`,
	);
	await fn(...paramValues);
}

/**
 * Create a RunFn that executes code in the main thread.
 */
export function createNativeRunFn(): RunFn {
	return async ({ code, hostFunctions }): Promise<RunCodeResult> => {
		const log: LogEntry[] = [];
		const consoleFns = createConsoleHostFunctions((level, text) => {
			log.push({ level, text });
		});
		const allFns = mergeHostFunctions(consoleFns, hostFunctions ?? []);
		const globals = buildGlobals(allFns);

		let exitCode = 0;
		try {
			await execute(code, globals);
		} catch (err) {
			exitCode = 1;
			const message = err instanceof Error ? err.message : String(err);
			log.push({ level: "error", text: message });
		}

		return buildResult(log, exitCode);
	};
}
