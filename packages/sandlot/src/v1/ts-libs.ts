/**
 * TypeScript standard library fetcher and cache.
 *
 * Fetches TypeScript's lib.*.d.ts files from jsDelivr CDN and caches
 * them in memory. These files provide types for built-in JavaScript APIs
 * (Array, Number, String) and browser APIs (console, window, document).
 */

/**
 * TypeScript version to fetch libs for.
 * MUST match the version in package.json dependencies.
 */
const TS_VERSION = "5.9.3";

/**
 * CDN base URL for TypeScript lib files
 */
const CDN_BASE = `https://cdn.jsdelivr.net/npm/typescript@${TS_VERSION}/lib`;

/**
 * Default libs for browser environment with ES2020 target.
 * These provide types for console, DOM APIs, and modern JS features.
 */
export function getDefaultBrowserLibs(): string[] {
  return ["es2020", "dom", "dom.iterable"];
}

/**
 * Parse `/// <reference lib="..." />` directives from a lib file.
 * These directives indicate dependencies on other lib files.
 *
 * @param content - The content of a lib.*.d.ts file
 * @returns Array of lib names referenced (without "lib." prefix or ".d.ts" suffix)
 */
export function parseLibReferences(content: string): string[] {
  const refs: string[] = [];
  const regex = /\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/>/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    if (match[1]) {
      refs.push(match[1]);
    }
  }

  return refs;
}

/**
 * Convert a lib name to its filename.
 * e.g., "es2020" -> "lib.es2020.d.ts"
 */
export function libNameToFileName(name: string): string {
  return `lib.${name}.d.ts`;
}

/**
 * Extract lib name from a file path.
 * e.g., "/node_modules/typescript/lib/lib.es2020.d.ts" -> "es2020"
 *       "lib.dom.d.ts" -> "dom"
 */
export function extractLibName(filePath: string): string | null {
  const match = filePath.match(/lib\.([^/]+)\.d\.ts$/);
  return match?.[1] ?? null;
}

/**
 * Fetch a single lib file from the CDN.
 *
 * @param name - The lib name (e.g., "es2020", "dom")
 * @returns The content of the lib file
 * @throws Error if the fetch fails
 */
export async function fetchLibFile(name: string): Promise<string> {
  const fileName = libNameToFileName(name);
  const url = `${CDN_BASE}/${fileName}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

/**
 * Recursively fetch all lib files needed for the given libs.
 * Parses `/// <reference lib="..." />` directives and fetches dependencies.
 *
 * @param libs - Initial lib names to fetch (e.g., ["es2020", "dom"])
 * @returns Map of lib name to content
 */
export async function fetchAllLibs(libs: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const pending = new Set<string>(libs);
  const fetched = new Set<string>();

  while (pending.size > 0) {
    // Get next batch of libs to fetch
    const batch = Array.from(pending);
    pending.clear();

    // Fetch all in parallel
    const results = await Promise.all(
      batch.map(async (name) => {
        if (fetched.has(name)) {
          return { name, content: null };
        }
        fetched.add(name);

        try {
          const content = await fetchLibFile(name);
          return { name, content };
        } catch (err) {
          console.warn(`Failed to fetch lib.${name}.d.ts:`, err);
          return { name, content: null };
        }
      })
    );

    // Process results and find new dependencies
    for (const { name, content } of results) {
      if (content === null) continue;

      result.set(name, content);

      // Parse references and add unfetched ones to pending
      const refs = parseLibReferences(content);
      for (const ref of refs) {
        if (!fetched.has(ref) && !pending.has(ref)) {
          pending.add(ref);
        }
      }
    }
  }

  return result;
}

/**
 * In-memory cache for TypeScript lib files.
 * Shared across all LibCache instances.
 */
let memoryCache: Map<string, string> | null = null;

/**
 * LibCache provides in-memory caching for TypeScript lib files.
 *
 * Usage:
 * ```ts
 * const cache = new LibCache();
 * const libs = await cache.getOrFetch(getDefaultBrowserLibs());
 * ```
 */
export class LibCache {
  /**
   * Get cached libs if available, otherwise fetch from CDN and cache.
   *
   * @param libs - Lib names to fetch (e.g., ["es2020", "dom"])
   * @returns Map of lib name to content (includes all transitive dependencies)
   */
  async getOrFetch(libs: string[]): Promise<Map<string, string>> {
    // Try to get from cache first
    if (memoryCache) {
      // Verify all requested libs are in cache
      const missing = libs.filter((lib) => !memoryCache!.has(lib));
      if (missing.length === 0) {
        return memoryCache;
      }
      // Some libs missing, fetch all and update cache
      console.log(`Cache missing libs: ${missing.join(", ")}, fetching all...`);
    }

    // Fetch from CDN
    console.log(`Fetching TypeScript libs from CDN: ${libs.join(", ")}...`);
    const fetched = await fetchAllLibs(libs);
    console.log(`Fetched ${fetched.size} lib files`);

    // Cache the results
    memoryCache = fetched;

    return fetched;
  }

  /**
   * Get cached libs if available.
   */
  get(): Map<string, string> | null {
    return memoryCache;
  }

  /**
   * Store libs in the cache.
   */
  set(libs: Map<string, string>): void {
    memoryCache = libs;
  }

  /**
   * Clear all cached libs.
   */
  clear(): void {
    memoryCache = null;
  }
}

/**
 * Convenience function to fetch and cache libs in one call.
 *
 * @param libs - Lib names to fetch (defaults to getDefaultBrowserLibs())
 * @returns Map of lib name to content
 */
export async function fetchAndCacheLibs(
  libs: string[] = getDefaultBrowserLibs()
): Promise<Map<string, string>> {
  const cache = new LibCache();
  return cache.getOrFetch(libs);
}
