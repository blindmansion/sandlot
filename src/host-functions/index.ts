/**
 * Factories for building Sand.* host functions.
 *
 * Each module (fs, env, etc.) has its own factory that takes a backing
 * implementation and returns `HostFunction[]`. The top-level
 * {@link createSandHostFunctions} composes them into a single array.
 */

import type { BundleFn } from "../bundle";
import type { HostFunction } from "../run/types";
import type { RunFn } from "../run/types";
import type { UnionFileSystem } from "../types";
import { createFsHostFunctions } from "./fs";

export { createConsoleHostFunctions } from "./console";
export { createFsHostFunctions } from "./fs";

export interface CreateSandHostFunctionsOptions {
	/** Filesystem implementation for Sand.fs.* functions */
	fs?: UnionFileSystem;
	/** Bundle function used by Sand.run. Requires fs and runFn. */
	bundleFn?: BundleFn;
	/** Runtime function used by Sand.run. Requires fs and bundleFn. */
	runFn?: RunFn;
	/** Override the host functions inherited by child Sand.run executions. */
	getHostFunctions?: () => HostFunction[];
}

/**
 * Create all Sand.* host functions from the provided implementations.
 *
 * Composes the individual module factories (fs, env, etc.) into a
 * single `HostFunction[]` array ready to pass to `createSandlotCommand`
 * or `createRunCommand`.
 *
 * @example
 * ```ts
 * import { InMemoryFs } from "just-bash";
 * import { createSandHostFunctions } from "sandlot/host-functions";
 *
 * const hostFunctions = createSandHostFunctions({
 *   fs: new InMemoryFs({ "/hello.txt": "world" }),
 * });
 *
 * const sand = createSandlotCommand({ hostFunctions, runFn, bundleFn });
 * ```
 */
export function createSandHostFunctions(
	options: CreateSandHostFunctionsOptions = {},
): HostFunction[] {
	const functions: HostFunction[] = [];

	if (options.fs) {
		functions.push(...createFsHostFunctions(options.fs));
	}

	return functions;
}
