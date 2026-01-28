/**
 * Types Resolver - Fetches TypeScript type definitions for npm packages.
 *
 * This is a platform-independent implementation that works anywhere with fetch().
 * (Browser, Node 18+, Bun, Deno, Cloudflare Workers)
 *
 * Design principles:
 * 1. Single responsibility: resolve package → types. No VFS writing.
 * 2. CDN-agnostic interface with esm.sh implementation
 * 3. Transparent @types fallback (caller doesn't need to know)
 * 4. Subpaths resolved on-demand, not pre-fetched
 * 5. Caching is external/injectable (platform-specific cache implementations)
 */

import type { ITypesResolver } from "../types";

// =============================================================================
// Types
// =============================================================================

/**
 * Resolved type definitions for a package.
 */
export interface ResolvedTypes {
  /**
   * The package name (may differ from request if @types fallback was used)
   */
  packageName: string;

  /**
   * The resolved version
   */
  version: string;

  /**
   * Map of relative file paths to content.
   * Paths are relative to the package root (e.g., "index.d.ts", "utils.d.ts")
   */
  files: Record<string, string>;

  /**
   * Whether types came from @types/* package
   */
  fromTypesPackage: boolean;
}

/**
 * Cache interface for type definitions.
 * Implementations can be in-memory, IndexedDB, KV store, filesystem, etc.
 */
export interface ITypesCache {
  get(key: string): Promise<ResolvedTypes | null>;
  set(key: string, value: ResolvedTypes): Promise<void>;
  has(key: string): Promise<boolean>;
}

/**
 * Simple in-memory cache implementation.
 * Works on all platforms.
 */
export class InMemoryTypesCache implements ITypesCache {
  private cache = new Map<string, ResolvedTypes>();

  async get(key: string): Promise<ResolvedTypes | null> {
    return this.cache.get(key) ?? null;
  }

  async set(key: string, value: ResolvedTypes): Promise<void> {
    this.cache.set(key, value);
  }

  async has(key: string): Promise<boolean> {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }
}

// =============================================================================
// EsmTypesResolver
// =============================================================================

export interface EsmTypesResolverOptions {
  /**
   * Base URL for esm.sh (default: "https://esm.sh")
   */
  baseUrl?: string;

  /**
   * External cache. If not provided, no caching is done.
   * This allows sharing cache across resolver instances.
   */
  cache?: ITypesCache;

  /**
   * Whether to try @types/* packages as fallback when main package
   * doesn't have bundled types. Default: true
   */
  tryTypesPackages?: boolean;
}

/**
 * Types resolver using esm.sh CDN.
 *
 * Platform-independent - works anywhere with fetch().
 *
 * Resolution strategy:
 * 1. Fetch package from esm.sh, check X-TypeScript-Types header
 * 2. If no types, try @types/{package} as fallback
 * 3. Fetch .d.ts files and any /// <reference> dependencies
 *
 * @example
 * ```ts
 * const resolver = new EsmTypesResolver();
 *
 * // Resolve types for a package
 * const types = await resolver.resolve("lodash", "4.17.21");
 * // types.files: { "index.d.ts": "...", "common.d.ts": "..." }
 *
 * // Resolve subpath types
 * const clientTypes = await resolver.resolve("react-dom/client", "18.2.0");
 * ```
 */
export class EsmTypesResolver implements ITypesResolver {
  private baseUrl: string;
  private cache: ITypesCache | null;
  private tryTypesPackages: boolean;

  constructor(options: EsmTypesResolverOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://esm.sh";
    this.cache = options.cache ?? null;
    this.tryTypesPackages = options.tryTypesPackages ?? true;
  }

  /**
   * Resolve type definitions for a package.
   *
   * @param specifier - Package specifier with optional subpath (e.g., "react", "react-dom/client")
   * @param version - Optional version constraint
   * @returns Map of file paths to content, or empty object if no types found
   */
  async resolveTypes(
    specifier: string,
    version?: string
  ): Promise<Record<string, string>> {
    const resolved = await this.resolve(specifier, version);
    if (!resolved) {
      return {};
    }

    // Prefix paths with package location for VFS
    const result: Record<string, string> = {};
    const pkgPath = `/node_modules/${resolved.packageName}`;

    for (const [relativePath, content] of Object.entries(resolved.files)) {
      result[`${pkgPath}/${relativePath}`] = content;
    }

    return result;
  }

  /**
   * Resolve with full metadata (useful for advanced use cases).
   */
  async resolve(
    specifier: string,
    version?: string
  ): Promise<ResolvedTypes | null> {
    const { packageName, subpath } = parseSpecifier(specifier);
    const cacheKey = makeCacheKey(packageName, subpath, version);

    // Check cache first
    if (this.cache) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Try to resolve types
    let result = await this.tryResolve(packageName, subpath, version);

    // Fallback to @types package if enabled and no types found
    if (!result && this.tryTypesPackages && !packageName.startsWith("@types/")) {
      const typesPackageName = toTypesPackageName(packageName);
      result = await this.tryResolve(typesPackageName, subpath, version);
      if (result) {
        result.fromTypesPackage = true;
        // Keep original package name for the result so caller knows what they asked for
        result.packageName = packageName;
      }
    }

    // Cache the result
    if (result && this.cache) {
      await this.cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * Attempt to resolve types for a specific package.
   */
  private async tryResolve(
    packageName: string,
    subpath: string | undefined,
    version: string | undefined
  ): Promise<ResolvedTypes | null> {
    try {
      // Build URL
      const versionSuffix = version ? `@${version}` : "";
      const pathSuffix = subpath ? `/${subpath}` : "";
      const url = `${this.baseUrl}/${packageName}${versionSuffix}${pathSuffix}`;

      // Fetch to get headers (types URL, resolved version)
      const response = await fetch(url, { method: "HEAD" });
      if (!response.ok) {
        return null;
      }

      // Extract resolved version from URL or headers
      const resolvedVersion = this.extractVersion(response, packageName, version);

      // Get types URL from header
      const typesHeader = response.headers.get("X-TypeScript-Types");
      if (!typesHeader) {
        return null;
      }

      const typesUrl = new URL(typesHeader, response.url).href;

      // Fetch the types
      const files = await this.fetchTypesRecursively(typesUrl, subpath);

      if (Object.keys(files).length === 0) {
        return null;
      }

      return {
        packageName,
        version: resolvedVersion,
        files,
        fromTypesPackage: packageName.startsWith("@types/"),
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch a .d.ts file and any files it references.
   */
  private async fetchTypesRecursively(
    entryUrl: string,
    subpath: string | undefined,
    visited = new Set<string>()
  ): Promise<Record<string, string>> {
    if (visited.has(entryUrl)) {
      return {};
    }
    visited.add(entryUrl);

    const response = await fetch(entryUrl);
    if (!response.ok) {
      return {};
    }

    const content = await response.text();
    const files: Record<string, string> = {};

    // Determine the file path
    // For main entry: "index.d.ts"
    // For subpath "client": "client.d.ts" (or "client/index.d.ts")
    const fileName = subpath ? `${subpath}.d.ts` : "index.d.ts";
    files[fileName] = content;

    // If this is a subpath, also create the directory form
    // e.g., react-dom/client can be imported, needs client/index.d.ts too
    if (subpath) {
      files[`${subpath}/index.d.ts`] = content;
    }

    // Parse and fetch referenced files
    const refs = parseReferences(content);

    for (const ref of refs.paths) {
      const refUrl = new URL(ref, entryUrl).href;
      const refFiles = await this.fetchTypesRecursively(refUrl, undefined, visited);

      // Add referenced files with their relative paths
      for (const [refPath, refContent] of Object.entries(refFiles)) {
        // Compute relative path from the reference
        const normalizedRef = ref.replace(/^\.\//, "");
        if (refPath === "index.d.ts") {
          files[normalizedRef] = refContent;
        } else {
          const dir = normalizedRef.replace(/\.d\.ts$/, "");
          files[`${dir}/${refPath}`] = refContent;
        }
      }
    }

    return files;
  }

  /**
   * Extract the resolved version from the response.
   */
  private extractVersion(
    response: Response,
    packageName: string,
    requestedVersion: string | undefined
  ): string {
    // Try x-esm-id header first (most reliable)
    const esmId = response.headers.get("x-esm-id");
    if (esmId) {
      const match = esmId.match(new RegExp(`${escapeRegex(packageName)}@([^/]+)`));
      if (match?.[1]) {
        return match[1];
      }
    }

    // Try extracting from final URL
    const urlMatch = response.url.match(new RegExp(`${escapeRegex(packageName)}@([^/]+)`));
    if (urlMatch?.[1]) {
      return urlMatch[1];
    }

    // Fall back to requested version or "latest"
    return requestedVersion ?? "latest";
  }
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Parse a package specifier into package name and optional subpath.
 *
 * @example
 * parseSpecifier("react") // { packageName: "react", subpath: undefined }
 * parseSpecifier("react-dom/client") // { packageName: "react-dom", subpath: "client" }
 * parseSpecifier("@tanstack/react-query") // { packageName: "@tanstack/react-query", subpath: undefined }
 * parseSpecifier("@tanstack/react-query/devtools") // { packageName: "@tanstack/react-query", subpath: "devtools" }
 */
function parseSpecifier(specifier: string): {
  packageName: string;
  subpath: string | undefined;
} {
  if (specifier.startsWith("@")) {
    // Scoped package: @scope/name or @scope/name/subpath
    const parts = specifier.split("/");
    if (parts.length >= 2) {
      const packageName = `${parts[0]}/${parts[1]}`;
      const subpath = parts.length > 2 ? parts.slice(2).join("/") : undefined;
      return { packageName, subpath };
    }
    return { packageName: specifier, subpath: undefined };
  }

  // Regular package: name or name/subpath
  const slashIndex = specifier.indexOf("/");
  if (slashIndex === -1) {
    return { packageName: specifier, subpath: undefined };
  }

  return {
    packageName: specifier.slice(0, slashIndex),
    subpath: specifier.slice(slashIndex + 1),
  };
}

/**
 * Convert a package name to its @types/* equivalent.
 *
 * @example
 * toTypesPackageName("lodash") // "@types/lodash"
 * toTypesPackageName("@tanstack/react-query") // "@types/tanstack__react-query"
 */
function toTypesPackageName(packageName: string): string {
  if (packageName.startsWith("@")) {
    // Scoped: @scope/name -> @types/scope__name
    return "@types/" + packageName.slice(1).replace("/", "__");
  }
  return `@types/${packageName}`;
}

/**
 * Parse /// <reference> directives from a .d.ts file.
 */
function parseReferences(content: string): { paths: string[]; types: string[] } {
  const paths: string[] = [];
  const types: string[] = [];

  // /// <reference path="..." />
  const pathRegex = /\/\/\/\s*<reference\s+path="([^"]+)"\s*\/>/g;
  let match;
  while ((match = pathRegex.exec(content)) !== null) {
    if (match[1]) paths.push(match[1]);
  }

  // /// <reference types="..." />
  const typesRegex = /\/\/\/\s*<reference\s+types="([^"]+)"\s*\/>/g;
  while ((match = typesRegex.exec(content)) !== null) {
    if (match[1]) types.push(match[1]);
  }

  return { paths, types };
}

/**
 * Create a cache key for a package resolution.
 */
function makeCacheKey(
  packageName: string,
  subpath: string | undefined,
  version: string | undefined
): string {
  const base = version ? `${packageName}@${version}` : packageName;
  return subpath ? `${base}/${subpath}` : base;
}

/**
 * Escape special regex characters.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
