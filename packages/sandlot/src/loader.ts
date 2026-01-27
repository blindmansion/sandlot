/**
 * Module loader utilities for Sandlot bundles.
 *
 * Takes a BundleResult and turns it into usable JavaScript exports.
 * No external dependencies - just the basics for loading compiled code.
 *
 * @example
 * ```ts
 * // Capture the bundle via onBuild callback
 * let buildResult: BundleResult | null = null;
 * const unsubscribe = sandbox.onBuild((result) => {
 *   buildResult = result;
 * });
 *
 * const cmd = await sandbox.bash.exec("build /src/index.ts");
 * if (cmd.exitCode === 0 && buildResult) {
 *   // Load all exports
 *   const module = await loadModule<{ add: (a: number, b: number) => number }>(buildResult);
 *   console.log(module.add(1, 2)); // 3
 *
 *   // Load a specific export
 *   const add = await loadExport<(a: number, b: number) => number>(buildResult, "add");
 *   console.log(add(1, 2)); // 3
 * }
 * unsubscribe();
 * ```
 */

import type { BundleResult } from "./bundler";

/**
 * Error thrown when loading a module fails
 */
export class ModuleLoadError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ModuleLoadError";
  }
}

/**
 * Error thrown when an expected export is not found
 */
export class ExportNotFoundError extends Error {
  constructor(
    public readonly exportName: string,
    public readonly availableExports: string[]
  ) {
    super(
      `Export "${exportName}" not found. Available exports: ${availableExports.length > 0 ? availableExports.join(", ") : "(none)"
      }`
    );
    this.name = "ExportNotFoundError";
  }
}

/**
 * Create a blob URL for a bundle that can be dynamically imported.
 * Remember to call `revokeModuleUrl()` when done to free memory.
 *
 * @param result - The bundle result from a successful build
 * @returns A blob URL that can be passed to `import()`
 *
 * @example
 * ```ts
 * const url = createModuleUrl(buildResult);
 * try {
 *   const module = await import(url);
 *   console.log(module.default);
 * } finally {
 *   revokeModuleUrl(url);
 * }
 * ```
 */
export function createModuleUrl(result: BundleResult): string {
  const blob = new Blob([result.code], { type: "application/javascript" });
  return URL.createObjectURL(blob);
}

/**
 * Revoke a blob URL created by `createModuleUrl()`.
 * This frees the memory associated with the blob.
 *
 * @param url - The blob URL to revoke
 */
export function revokeModuleUrl(url: string): void {
  URL.revokeObjectURL(url);
}

/**
 * Load all exports from a bundle result.
 *
 * @typeParam T - The expected shape of the module's exports
 * @param result - The bundle result from a successful build
 * @returns A promise that resolves to the module's exports
 * @throws {ModuleLoadError} If the module fails to load
 *
 * @example
 * ```ts
 * interface MyModule {
 *   add: (a: number, b: number) => number;
 *   multiply: (a: number, b: number) => number;
 * }
 *
 * const module = await loadModule<MyModule>(buildResult);
 * console.log(module.add(2, 3)); // 5
 * console.log(module.multiply(2, 3)); // 6
 * ```
 */
export async function loadModule<T = Record<string, unknown>>(
  result: BundleResult
): Promise<T> {
  const url = createModuleUrl(result);
  try {
    // @vite-ignore comment prevents Vite from trying to analyze this dynamic import
    const module = await import(/* @vite-ignore */ url);
    return module as T;
  } catch (err) {
    throw new ModuleLoadError(
      `Failed to load module: ${err instanceof Error ? err.message : String(err)}`,
      err
    );
  } finally {
    revokeModuleUrl(url);
  }
}

/**
 * Load a specific named export from a bundle result.
 *
 * @typeParam T - The expected type of the export
 * @param result - The bundle result from a successful build
 * @param exportName - The name of the export to retrieve (use "default" for default export)
 * @returns A promise that resolves to the export's value
 * @throws {ModuleLoadError} If the module fails to load
 * @throws {ExportNotFoundError} If the export doesn't exist
 *
 * @example
 * ```ts
 * // Load a named export
 * const add = await loadExport<(a: number, b: number) => number>(
 *   buildResult,
 *   "add"
 * );
 * console.log(add(2, 3)); // 5
 *
 * // Load the default export
 * const Calculator = await loadExport<typeof Calculator>(
 *   buildResult,
 *   "default"
 * );
 * ```
 */
export async function loadExport<T = unknown>(
  result: BundleResult,
  exportName: string = "default"
): Promise<T> {
  const module = await loadModule<Record<string, unknown>>(result);

  if (!(exportName in module)) {
    const availableExports = Object.keys(module).filter(
      (key) => !key.startsWith("__")
    );
    throw new ExportNotFoundError(exportName, availableExports);
  }

  return module[exportName] as T;
}

/**
 * Load the default export from a bundle result.
 * Convenience wrapper around `loadExport(result, "default")`.
 *
 * @typeParam T - The expected type of the default export
 * @param result - The bundle result from a successful build
 * @returns A promise that resolves to the default export
 * @throws {ModuleLoadError} If the module fails to load
 * @throws {ExportNotFoundError} If there is no default export
 *
 * @example
 * ```ts
 * // For a module that does: export default function add(a, b) { return a + b; }
 * const add = await loadDefault<(a: number, b: number) => number>(buildResult);
 * console.log(add(2, 3)); // 5
 * ```
 */
export async function loadDefault<T = unknown>(result: BundleResult): Promise<T> {
  return loadExport<T>(result, "default");
}

/**
 * Get a list of export names from a bundle result.
 * Useful for introspection or debugging.
 *
 * @param result - The bundle result from a successful build
 * @returns A promise that resolves to an array of export names
 *
 * @example
 * ```ts
 * const exports = await getExportNames(buildResult);
 * console.log(exports); // ["add", "multiply", "default"]
 * ```
 */
export async function getExportNames(result: BundleResult): Promise<string[]> {
  const module = await loadModule<Record<string, unknown>>(result);
  return Object.keys(module).filter((key) => !key.startsWith("__"));
}

/**
 * Check if a bundle has a specific export.
 *
 * @param result - The bundle result from a successful build
 * @param exportName - The name of the export to check for
 * @returns A promise that resolves to true if the export exists
 *
 * @example
 * ```ts
 * if (await hasExport(buildResult, "add")) {
 *   const add = await loadExport(buildResult, "add");
 * }
 * ```
 */
export async function hasExport(
  result: BundleResult,
  exportName: string
): Promise<boolean> {
  const module = await loadModule<Record<string, unknown>>(result);
  return exportName in module;
}
