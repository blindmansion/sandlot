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
import type { ICache } from "./persistor";

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

// =============================================================================
// EsmTypesResolver
// =============================================================================

export interface EsmTypesResolverOptions {
  /**
   * Base URL for esm.sh (default: "https://esm.sh")
   */
  baseUrl?: string;

  /**
   * External cache for resolved types. If not provided, no caching is done.
   * This allows sharing cache across resolver instances.
   * 
   * Key format: `${packageName}@${version}` or `${packageName}@${version}/${subpath}`
   */
  cache?: ICache<ResolvedTypes>;

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
  private cache: ICache<ResolvedTypes> | null;
  private tryTypesPackages: boolean;
  private lastRequestCount: number = 0;

  constructor(options: EsmTypesResolverOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://esm.sh";
    this.cache = options.cache ?? null;
    this.tryTypesPackages = options.tryTypesPackages ?? true;
  }

  /**
   * Get the number of HTTP requests made during the last resolveTypes call.
   */
  getLastRequestCount(): number {
    return this.lastRequestCount;
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
    // Reset request counter for this resolution
    this.lastRequestCount = 0;
    
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

    // Try to resolve types (with cache check using resolved version)
    let result = await this.tryResolveWithCache(packageName, subpath, version);

    // Fallback to @types package if enabled and no types found
    if (!result && this.tryTypesPackages && !packageName.startsWith("@types/")) {
      const typesPackageName = toTypesPackageName(packageName);
      result = await this.tryResolveWithCache(typesPackageName, subpath, version);
      if (result) {
        result.fromTypesPackage = true;
        // Keep original package name for the result so caller knows what they asked for
        result.packageName = packageName;
      }
    }

    return result;
  }

  /**
   * Resolve types with proper cache handling.
   * 
   * For versioned requests: check cache immediately with that version.
   * For unversioned requests: do a cheap HEAD request to get the resolved version,
   * then check cache with that version before doing expensive type fetching.
   */
  private async tryResolveWithCache(
    packageName: string,
    subpath: string | undefined,
    version: string | undefined
  ): Promise<ResolvedTypes | null> {
    // If version is specified, we can check cache immediately
    if (version && this.cache) {
      const cacheKey = makeCacheKey(packageName, subpath, version);
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Do HEAD request to get resolved version and types URL
    const headResult = await this.fetchPackageHead(packageName, subpath, version);
    if (!headResult) {
      return null;
    }

    const { resolvedVersion, typesUrl } = headResult;
    const cacheKey = makeCacheKey(packageName, subpath, resolvedVersion);

    // Check cache with resolved version (covers unversioned requests)
    if (this.cache) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Cache miss - do the expensive recursive type fetching
    const files = await this.fetchTypesRecursively(typesUrl, subpath);

    if (Object.keys(files).length === 0) {
      return null;
    }

    const result: ResolvedTypes = {
      packageName,
      version: resolvedVersion,
      files,
      fromTypesPackage: packageName.startsWith("@types/"),
    };

    // Cache the result
    if (this.cache) {
      await this.cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * Lightweight HEAD request to get package metadata without fetching types.
   * Returns the resolved version and types URL.
   */
  private async fetchPackageHead(
    packageName: string,
    subpath: string | undefined,
    version: string | undefined
  ): Promise<{ resolvedVersion: string; typesUrl: string } | null> {
    try {
      const versionSuffix = version ? `@${version}` : "";
      const pathSuffix = subpath ? `/${subpath}` : "";
      const url = `${this.baseUrl}/${packageName}${versionSuffix}${pathSuffix}`;

      this.lastRequestCount++;
      const response = await fetch(url, { method: "HEAD" });
      if (!response.ok) {
        return null;
      }

      const resolvedVersion = this.extractVersion(response, packageName, version);

      const typesHeader = response.headers.get("X-TypeScript-Types");
      if (!typesHeader) {
        return null;
      }

      const typesUrl = new URL(typesHeader, response.url).href;

      return { resolvedVersion, typesUrl };
    } catch {
      return null;
    }
  }

  /** Maximum concurrent fetches to avoid overwhelming the server */
  private static readonly MAX_CONCURRENT_FETCHES = 20;

  /**
   * Fetch a .d.ts file and any files it references via:
   * - /// <reference path="..." /> directives
   * - ES module imports/exports (import from "./...", export * from "./...")
   * 
   * Uses parallel fetching with batching for performance.
   */
  private async fetchTypesRecursively(
    entryUrl: string,
    subpath: string | undefined,
    visited = new Set<string>()
  ): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    
    // Queue of files to fetch: { url, relativePath }
    // url is used for fetching and resolving relative imports
    // relativePath is where to store the file in the result
    const queue: Array<{ url: string; relativePath: string }> = [];
    
    // Add entry point to queue
    const entryPath = subpath ? `${subpath}.d.ts` : "index.d.ts";
    queue.push({ url: entryUrl, relativePath: entryPath });
    visited.add(entryUrl);

    // Process queue in batches
    while (queue.length > 0) {
      // Take a batch from the queue
      const batch = queue.splice(0, EsmTypesResolver.MAX_CONCURRENT_FETCHES);
      
      // Count requests for this batch
      this.lastRequestCount += batch.length;
      
      // Fetch all files in this batch in parallel
      const results = await Promise.all(
        batch.map(async ({ url, relativePath }) => {
          try {
            const response = await fetch(url);
            if (!response.ok) {
              return { url, relativePath, content: null };
            }
            const content = await response.text();
            return { url, relativePath, content };
          } catch {
            return { url, relativePath, content: null };
          }
        })
      );

      // Process results and queue new dependencies
      for (const { url, relativePath, content } of results) {
        if (content === null) continue;

        // Store the file
        const normalizedPath = relativePath.replace(/^\.\//, "");
        files[normalizedPath] = content;

        // Parse dependencies
        const refs = parseReferences(content);
        const moduleImports = parseModuleImports(content);

        // Get the directory of the current file to resolve relative paths
        const currentDir = normalizedPath.includes("/")
          ? normalizedPath.substring(0, normalizedPath.lastIndexOf("/"))
          : "";

        // Queue reference directives - resolve relative to this file's URL
        for (const ref of refs.paths) {
          const refUrl = new URL(ref, url).href;
          if (visited.has(refUrl)) continue;
          visited.add(refUrl);

          const resolvedPath = resolvePath(currentDir, ref);
          queue.push({ url: refUrl, relativePath: resolvedPath });
        }

        // Queue ES module imports - resolve relative to this file's URL
        for (const importPath of moduleImports) {
          const importUrl = new URL(importPath, url).href;
          if (visited.has(importUrl)) continue;
          visited.add(importUrl);

          const resolvedPath = resolvePath(currentDir, importPath);
          queue.push({ url: importUrl, relativePath: resolvedPath });
        }
      }
    }

    // If this is a subpath, also create the directory form
    if (subpath && files[`${subpath}.d.ts`]) {
      files[`${subpath}/index.d.ts`] = files[`${subpath}.d.ts`];
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
    const versionRegex = new RegExp(`${escapeRegex(packageName)}@([^/]+)`);

    // Try x-esm-id header first (most reliable)
    const esmId = response.headers.get("x-esm-id");
    if (esmId) {
      const match = esmId.match(versionRegex);
      if (match?.[1]) {
        return match[1];
      }
    }

    // Try extracting from final URL
    const urlMatch = response.url.match(versionRegex);
    if (urlMatch?.[1]) {
      return urlMatch[1];
    }

    // Try extracting from x-typescript-types header URL
    const typesHeader = response.headers.get("x-typescript-types");
    if (typesHeader) {
      const typesMatch = typesHeader.match(versionRegex);
      if (typesMatch?.[1]) {
        return typesMatch[1];
      }
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
 * Parse ES module import/export statements to find relative .d.ts dependencies.
 * 
 * Handles:
 * - import { foo } from "./foo.d.ts"
 * - import * as foo from "./foo.d.ts"
 * - import foo from "./foo.d.ts"
 * - export * from "./foo.d.ts"
 * - export { foo } from "./foo.d.ts"
 * - export type { Foo } from "./foo.d.ts"
 * - import type { Foo } from "./foo.d.ts"
 * 
 * Only returns relative paths (starting with ./ or ../)
 */
function parseModuleImports(content: string): string[] {
  const imports: string[] = [];
  const seen = new Set<string>();
  
  // Match import/export statements with from clause
  // Handles: import/export [type] [{ ... } | * as name | name] from "specifier"
  const importExportRegex = /(?:import|export)\s+(?:type\s+)?(?:\*\s+as\s+\w+|[\w,{}\s*]+)\s+from\s+["']([^"']+)["']/g;
  
  let match;
  while ((match = importExportRegex.exec(content)) !== null) {
    const specifier = match[1];
    // Only include relative paths
    if (specifier && (specifier.startsWith("./") || specifier.startsWith("../"))) {
      if (!seen.has(specifier)) {
        seen.add(specifier);
        imports.push(specifier);
      }
    }
  }
  
  // Also handle: export * from "specifier" (simpler form without braces)
  const exportStarRegex = /export\s+\*\s+from\s+["']([^"']+)["']/g;
  while ((match = exportStarRegex.exec(content)) !== null) {
    const specifier = match[1];
    if (specifier && (specifier.startsWith("./") || specifier.startsWith("../"))) {
      if (!seen.has(specifier)) {
        seen.add(specifier);
        imports.push(specifier);
      }
    }
  }
  
  return imports;
}

/**
 * Create a cache key for a package resolution.
 * Format: `types:${package}@${version}` or `types:${package}@${version}/${subpath}`
 * When version is not specified, uses `types:${package}` (for unversioned requests)
 */
function makeCacheKey(
  packageName: string,
  subpath: string | undefined,
  version: string | undefined
): string {
  const base = version ? `${packageName}@${version}` : packageName;
  const key = subpath ? `${base}/${subpath}` : base;
  return `types:${key}`;
}

/**
 * Escape special regex characters.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve a relative path against a base directory.
 * 
 * @example
 * resolvePath("v4/classic", "./schemas.d.ts") // "v4/classic/schemas.d.ts"
 * resolvePath("v4/classic", "../core/index.d.ts") // "v4/core/index.d.ts"
 * resolvePath("", "./foo.d.ts") // "foo.d.ts"
 */
function resolvePath(baseDir: string, relativePath: string): string {
  // Remove leading ./
  let path = relativePath.replace(/^\.\//, "");
  
  // If no ../, just join
  if (!path.startsWith("../")) {
    return baseDir ? `${baseDir}/${path}` : path;
  }
  
  // Handle ../
  const baseParts = baseDir ? baseDir.split("/") : [];
  const pathParts = path.split("/");
  
  while (pathParts[0] === "..") {
    pathParts.shift();
    baseParts.pop();
  }
  
  const resolved = [...baseParts, ...pathParts].join("/");
  return resolved;
}
