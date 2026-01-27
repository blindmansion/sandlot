/**
 * Shared resources for sandbox environments.
 *
 * Provides centralized management of expensive shared resources:
 * - TypeScript lib files (~5MB) - loaded once, shared across all sandboxes
 * - esbuild WASM (~10MB) - singleton bundler initialization
 * - Types cache - avoids redundant network fetches when multiple sandboxes
 *   install the same packages
 */

import { fetchAndCacheLibs, getDefaultBrowserLibs } from "./ts-libs";
import { initBundler } from "./bundler";
import { InMemoryTypesCache, type TypesCache } from "./packages";

// Re-export for consumers
export type { TypesCache } from "./packages";
export { InMemoryTypesCache } from "./packages";

/**
 * Shared resources that can be reused across multiple sandboxes
 */
export interface SharedResources {
  /**
   * Pre-loaded TypeScript lib files for type checking
   */
  libFiles: Map<string, string>;

  /**
   * Promise that resolves when the bundler is ready
   */
  bundlerReady: Promise<void>;

  /**
   * Cache for package type definitions.
   * Avoids redundant network fetches when multiple sandboxes
   * install the same packages.
   */
  typesCache: TypesCache;
}

/**
 * Options for creating shared resources
 */
export interface SharedResourcesOptions {
  /**
   * TypeScript libs to load. Defaults to browser libs (ES2020 + DOM).
   */
  libs?: string[];

  /**
   * If true, skip fetching TypeScript libs.
   * libFiles will be an empty Map.
   * Default: false
   */
  skipLibs?: boolean;

  /**
   * If true, skip pre-initializing the bundler.
   * bundlerReady will resolve immediately.
   * Default: false
   */
  skipBundler?: boolean;
}

/**
 * Create a new SharedResources instance.
 *
 * Use this when you want to manage resource lifecycle explicitly,
 * or when you need custom libs configuration.
 *
 * @example
 * ```ts
 * // Create resources with custom libs
 * const resources = await createSharedResources({
 *   libs: ['es2022', 'dom', 'webworker'],
 * });
 *
 * // Pass to sandbox creation
 * const sandbox = await createSandbox({
 *   resources,
 *   fsOptions: { ... },
 * });
 * ```
 */
export async function createSharedResources(
  options: SharedResourcesOptions = {}
): Promise<SharedResources> {
  const { libs = getDefaultBrowserLibs(), skipLibs = false, skipBundler = false } = options;

  // Start both in parallel
  const libsPromise = skipLibs
    ? Promise.resolve(new Map<string, string>())
    : fetchAndCacheLibs(libs);

  const bundlerPromise = skipBundler ? Promise.resolve() : initBundler();

  // Create types cache (synchronous, just an in-memory Map)
  const typesCache = new InMemoryTypesCache();

  // Wait for async initialization
  const [libFiles] = await Promise.all([libsPromise, bundlerPromise]);

  return {
    libFiles,
    bundlerReady: Promise.resolve(), // Already initialized
    typesCache,
  };
}

// ============ Module-level Singleton ============

/**
 * Module-level singleton for default shared resources.
 * Used by createSandbox() when no resources are provided.
 */
let defaultResourcesInstance: SharedResources | null = null;
let defaultResourcesPromise: Promise<SharedResources> | null = null;

/**
 * Get the default shared resources singleton.
 *
 * Loads resources once and returns the same instance for all callers.
 * This is the recommended way to get shared resources for most use cases.
 *
 * @example
 * ```ts
 * // Get default resources (creates on first call)
 * const resources = await getDefaultResources();
 *
 * // Create multiple sandboxes sharing the same resources
 * const sandbox1 = await createSandbox({ resources, ... });
 * const sandbox2 = await createSandbox({ resources, ... });
 * ```
 */
export async function getDefaultResources(): Promise<SharedResources> {
  if (defaultResourcesInstance) {
    return defaultResourcesInstance;
  }

  if (!defaultResourcesPromise) {
    defaultResourcesPromise = createSharedResources().then((resources) => {
      defaultResourcesInstance = resources;
      return resources;
    });
  }

  return defaultResourcesPromise;
}

/**
 * Clear the default resources singleton (for testing).
 *
 * Note: This doesn't unload the bundler WASM - that stays in memory
 * until page reload. This only clears the cached lib files reference.
 */
export function clearDefaultResources(): void {
  defaultResourcesInstance = null;
  defaultResourcesPromise = null;
}

/**
 * Check if the default resources have been initialized.
 */
export function hasDefaultResources(): boolean {
  return defaultResourcesInstance !== null;
}
