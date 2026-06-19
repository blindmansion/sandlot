/**
 * TypeChecker factory
 *
 * Creates a `TypecheckFn` with instance-scoped lib file caching.
 * Follows the same factory pattern as `createBundleFn` in the bundler module.
 */

import { createTypeCheckerEnv } from "./environment";
import { loadLibFilesFromCDN, RENDER_LIBS, RUN_LIBS } from "./lib-loader";
import { getAllDiagnostics } from "./services";
import type { TypecheckArgs, TypecheckDeps, TypecheckFn } from "./types";

/**
 * Get TypeScript lib files, loading from CDN if not cached.
 * Caches per mode ("run" vs "render") since they load different lib sets.
 *
 * The cache maps are passed in so each factory instance has its own cache,
 * avoiding shared global state across Sandlot instances.
 */
async function getOrLoadLibs(
	mode: "run" | "render",
	libCache: Map<string, Map<string, string>>,
	libPromises: Map<string, Promise<Map<string, string>>>,
): Promise<Map<string, string>> {
	// Return cached version if available
	const cached = libCache.get(mode);
	if (cached) {
		return cached;
	}

	// If already loading, wait for that promise
	const existing = libPromises.get(mode);
	if (existing) {
		return existing;
	}

	// Start loading from CDN with mode-appropriate libs
	const libs = mode === "run" ? RUN_LIBS : RENDER_LIBS;
	const promise = (async () => {
		const libMap = await loadLibFilesFromCDN(libs);
		libCache.set(mode, libMap);
		return libMap;
	})();

	libPromises.set(mode, promise);
	return promise;
}

/**
 * Create a typecheck function with instance-scoped lib file caching.
 *
 * @param deps - Optional dependencies (pre-loaded lib files, etc.)
 * @returns A `TypecheckFn` that type-checks a filesystem and returns diagnostics
 *
 * @example
 * ```ts
 * const typecheck = createTypecheckFn();
 * const result = await typecheck({ fs, mode: "render" });
 * console.log(result.diagnostics);
 * ```
 */
export function createTypecheckFn(deps: TypecheckDeps = {}): TypecheckFn {
	// Instance-scoped cache — not shared across Sandlot instances
	const libCache = new Map<string, Map<string, string>>();
	const libPromises = new Map<string, Promise<Map<string, string>>>();

	return async (args: TypecheckArgs) => {
		const mode = args.mode ?? "render";
		const libMap =
			deps.libMap ?? (await getOrLoadLibs(mode, libCache, libPromises));

		const { env, rootFiles } = await createTypeCheckerEnv(
			args.fs,
			libMap,
			args,
		);

		const diagnostics = getAllDiagnostics(
			env,
			rootFiles,
			args.includeSuggestions ?? true,
		);
		return { diagnostics, libMap };
	};
}
