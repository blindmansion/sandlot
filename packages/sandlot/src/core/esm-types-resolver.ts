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

  /**
   * Peer type dependencies detected from `export * from 'external-package'` statements.
   * These packages should also have their types installed for complete type resolution.
   */
  peerTypeDeps?: Array<{ packageName: string; version: string }>;
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
   * Resolve just the version for a package (lightweight HEAD request).
   * Used by install() to get the resolved version without fetching all types.
   */
  async resolveVersion(
    specifier: string,
    version?: string
  ): Promise<{ packageName: string; version: string } | null> {
    const { packageName, subpath } = parseSpecifier(specifier);

    // Try main package first
    let headResult = await this.fetchPackageHead(packageName, subpath, version);

    // Fallback to @types package if enabled and no types found
    if (!headResult && this.tryTypesPackages && !packageName.startsWith("@types/")) {
      const typesPackageName = toTypesPackageName(packageName);
      headResult = await this.fetchPackageHead(typesPackageName, subpath, version);
    }

    if (!headResult) {
      return null;
    }

    return {
      packageName,
      version: headResult.resolvedVersion,
    };
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
    const { files, peerTypeDeps } = await this.fetchTypesRecursively(typesUrl, subpath);

    if (Object.keys(files).length === 0) {
      return null;
    }

    const result: ResolvedTypes = {
      packageName,
      version: resolvedVersion,
      files,
      fromTypesPackage: packageName.startsWith("@types/"),
      peerTypeDeps: peerTypeDeps.length > 0 ? peerTypeDeps : undefined,
    };

    // Cache the result
    if (this.cache) {
      await this.cache.set(cacheKey, result);
    }

    return result;
  }

  /** Maximum retry attempts for transient errors (npm rate limits can be persistent) */
  private static readonly MAX_RETRIES = 4;
  
  /** Base delay for exponential backoff (ms) - higher for npm rate limiting */
  private static readonly RETRY_BASE_DELAY_MS = 1000;

  /**
   * Lightweight HEAD request to get package metadata without fetching types.
   * Returns the resolved version and types URL.
   * Includes retry logic for transient errors (5xx, network issues).
   */
  private async fetchPackageHead(
    packageName: string,
    subpath: string | undefined,
    version: string | undefined
  ): Promise<{ resolvedVersion: string; typesUrl: string } | null> {
    // Don't add @latest to URLs - esm.sh resolves to latest with bare URLs,
    // and @latest can trigger npm registry lookups that hit rate limits
    const versionSuffix = version && version !== "latest" ? `@${version}` : "";
    const pathSuffix = subpath ? `/${subpath}` : "";
    const url = `${this.baseUrl}/${packageName}${versionSuffix}${pathSuffix}`;

    for (let attempt = 0; attempt <= EsmTypesResolver.MAX_RETRIES; attempt++) {
      try {
        this.lastRequestCount++;
        const response = await fetch(url, { method: "HEAD" });
        
        // Retry on 5xx errors (server errors, rate limiting)
        if (response.status >= 500 && attempt < EsmTypesResolver.MAX_RETRIES) {
          const delay = EsmTypesResolver.RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
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
        // Retry on network errors
        if (attempt < EsmTypesResolver.MAX_RETRIES) {
          const delay = EsmTypesResolver.RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        return null;
      }
    }
    
    return null;
  }

  /** Maximum concurrent fetches to avoid overwhelming the server */
  private static readonly MAX_CONCURRENT_FETCHES = 20;

  /**
   * Fetch a URL with retry logic for transient errors.
   */
  private async fetchWithRetry(url: string): Promise<Response | null> {
    for (let attempt = 0; attempt <= EsmTypesResolver.MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url);
        
        // Retry on 5xx errors (server errors, rate limiting)
        if (response.status >= 500 && attempt < EsmTypesResolver.MAX_RETRIES) {
          const delay = EsmTypesResolver.RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        return response;
      } catch {
        // Retry on network errors
        if (attempt < EsmTypesResolver.MAX_RETRIES) {
          const delay = EsmTypesResolver.RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        return null;
      }
    }
    return null;
  }

  /**
   * Fetch a .d.ts file and any files it references via:
   * - /// <reference path="..." /> directives
   * - ES module imports/exports (import from "./...", export * from "./...")
   * 
   * Uses parallel fetching with batching for performance.
   * 
   * Also detects external package dependencies (export * from 'other-package')
   * and returns them as peer type dependencies.
   */
  private async fetchTypesRecursively(
    entryUrl: string,
    subpath: string | undefined,
    visited = new Set<string>()
  ): Promise<{
    files: Record<string, string>;
    peerTypeDeps: Array<{ packageName: string; version: string }>;
  }> {
    const files: Record<string, string> = {};
    const peerTypeDepsMap = new Map<string, { packageName: string; version: string }>();
    
    // Extract the package name from the entry URL to filter dependencies
    // Only follow absolute URLs that are for the same package
    const expectedPackage = extractPackageFromEsmUrl(entryUrl);
    
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
      
      // Fetch all files in this batch in parallel (with retry logic)
      const results = await Promise.all(
        batch.map(async ({ url, relativePath }) => {
          const response = await this.fetchWithRetry(url);
          if (!response || !response.ok) {
            return { url, relativePath, content: null };
          }
          try {
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

        // Store the file with rewritten imports
        const normalizedPath = relativePath.replace(/^\.\//, "");
        
        // Get the directory of the current file for computing relative paths
        const currentDir = normalizedPath.includes("/")
          ? normalizedPath.substring(0, normalizedPath.lastIndexOf("/"))
          : "";
        
        // Rewrite absolute esm.sh URLs to relative paths in the content
        // This is needed because TypeScript expects relative imports
        // Only rewrite URLs from the same package
        const rewrittenContent = rewriteEsmUrlsToRelative(content, currentDir, expectedPackage);
        files[normalizedPath] = rewrittenContent;

        // Parse dependencies (use original content before rewriting for URL extraction)
        const refs = parseReferences(content);
        const { relativePaths, absoluteUrls } = parseModuleImports(content);

        // Queue reference directives - resolve relative to this file's URL
        for (const ref of refs.paths) {
          const refUrl = new URL(ref, url).href;
          if (visited.has(refUrl)) continue;
          visited.add(refUrl);

          const resolvedPath = resolvePath(currentDir, ref);
          queue.push({ url: refUrl, relativePath: resolvedPath });
        }

        // Queue relative ES module imports - resolve relative to this file's URL
        for (const importPath of relativePaths) {
          const importUrl = new URL(importPath, url).href;
          if (visited.has(importUrl)) continue;
          visited.add(importUrl);

          const resolvedPath = resolvePath(currentDir, importPath);
          queue.push({ url: importUrl, relativePath: resolvedPath });
        }

        // Queue absolute esm.sh URLs - extract relative path from URL
        // esm.sh sometimes rewrites relative imports to absolute URLs
        // Only follow URLs from the same package
        // External packages are collected as peer type dependencies
        for (const absoluteUrl of absoluteUrls) {
          if (visited.has(absoluteUrl)) continue;
          visited.add(absoluteUrl);

          const extractedPath = extractRelativePathFromEsmUrl(absoluteUrl, expectedPackage ?? undefined);
          if (extractedPath) {
            // Same package - follow the import
            queue.push({ url: absoluteUrl, relativePath: extractedPath });
          } else {
            // Different package - collect as peer type dependency
            const packageInfo = extractPackageInfoFromEsmUrl(absoluteUrl);
            if (packageInfo && packageInfo.packageName !== expectedPackage) {
              const key = `${packageInfo.packageName}@${packageInfo.version}`;
              if (!peerTypeDepsMap.has(key)) {
                peerTypeDepsMap.set(key, packageInfo);
              }
            }
          }
        }
      }
    }

    // If this is a subpath, also create the directory form
    // Check both .d.ts and .d.mts extensions
    if (subpath) {
      if (files[`${subpath}.d.ts`]) {
        files[`${subpath}/index.d.ts`] = files[`${subpath}.d.ts`];
      } else if (files[`${subpath}.d.mts`]) {
        files[`${subpath}/index.d.ts`] = files[`${subpath}.d.mts`];
      }
    }
    
    // Also create directory forms for any top-level .d.mts files
    // This allows TypeScript to resolve subpath imports like "zustand/vanilla"
    for (const [path, content] of Object.entries(files)) {
      if (path.endsWith(".d.mts") && !path.includes("/")) {
        // e.g., "vanilla.d.mts" -> "vanilla/index.d.ts"
        const baseName = path.slice(0, -6); // Remove ".d.mts"
        const dirPath = `${baseName}/index.d.ts`;
        if (!files[dirPath]) {
          files[dirPath] = content;
        }
      }
    }

    return {
      files,
      peerTypeDeps: Array.from(peerTypeDepsMap.values()),
    };
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
 * Convert a @types/* package name back to its original package name.
 * This is used when rewriting imports from esm.sh URLs.
 * 
 * @example
 * fromTypesPackageName("@types/react") // "react"
 * fromTypesPackageName("@types/node") // "node"
 * fromTypesPackageName("@types/tanstack__react-query") // "@tanstack/react-query"
 * fromTypesPackageName("lodash") // "lodash" (unchanged if not a @types package)
 */
function fromTypesPackageName(packageName: string): string {
  if (!packageName.startsWith("@types/")) {
    return packageName;
  }
  
  const typesName = packageName.slice(7); // Remove "@types/"
  
  // Check if it's a scoped package (contains __)
  if (typesName.includes("__")) {
    // @types/scope__name -> @scope/name
    const [scope, ...nameParts] = typesName.split("__");
    return `@${scope}/${nameParts.join("__")}`;
  }
  
  // Simple package: @types/react -> react
  return typesName;
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
 * Strip comments from TypeScript/JavaScript code.
 * 
 * Removes:
 * - Multi-line comments (including JSDoc)
 * - Single-line comments
 * 
 * This is important for parseModuleImports to avoid matching import statements
 * that appear in documentation examples within comments.
 */
function stripComments(content: string): string {
  // Remove multi-line comments (including JSDoc)
  // This handles nested asterisks in JSDoc like /** ... */
  let result = content.replace(/\/\*[\s\S]*?\*\//g, "");
  
  // Remove single-line comments
  // Be careful not to remove URLs (https://) by requiring whitespace or line start before //
  result = result.replace(/(?:^|[^:])\/\/.*$/gm, "");
  
  return result;
}

/**
 * Result of parsing module imports.
 */
interface ParsedImports {
  /** Relative paths (./..., ../...) */
  relativePaths: string[];
  /** Absolute esm.sh URLs (https://esm.sh/...) */
  absoluteUrls: string[];
}

/**
 * Parse ES module import/export statements to find .d.ts dependencies.
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
 * Returns both:
 * - Relative paths (starting with ./ or ../)
 * - Absolute esm.sh URLs (esm.sh sometimes rewrites relative paths to absolute URLs)
 * 
 * NOTE: Comments are stripped first to avoid matching imports in documentation
 * examples (e.g., JSDoc @example blocks contain code samples that should not
 * be followed as actual dependencies).
 */
function parseModuleImports(content: string): ParsedImports {
  const relativePaths: string[] = [];
  const absoluteUrls: string[] = [];
  const seen = new Set<string>();
  
  // Strip comments to avoid matching imports in JSDoc examples
  const strippedContent = stripComments(content);
  
  // Match import/export statements with from clause
  // Handles: import/export [type] [{ ... } | * as name | name] from "specifier"
  const importExportRegex = /(?:import|export)\s+(?:type\s+)?(?:\*\s+as\s+\w+|[\w,{}\s*]+)\s+from\s+["']([^"']+)["']/g;
  
  let match;
  while ((match = importExportRegex.exec(strippedContent)) !== null) {
    const specifier = match[1];
    if (!specifier || seen.has(specifier)) continue;
    seen.add(specifier);
    
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      relativePaths.push(specifier);
    } else if (specifier.startsWith("https://esm.sh/")) {
      absoluteUrls.push(specifier);
    }
  }
  
  // Also handle: export * from "specifier" (simpler form without braces)
  const exportStarRegex = /export\s+\*\s+from\s+["']([^"']+)["']/g;
  while ((match = exportStarRegex.exec(strippedContent)) !== null) {
    const specifier = match[1];
    if (!specifier || seen.has(specifier)) continue;
    seen.add(specifier);
    
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      relativePaths.push(specifier);
    } else if (specifier.startsWith("https://esm.sh/")) {
      absoluteUrls.push(specifier);
    }
  }
  
  return { relativePaths, absoluteUrls };
}

/**
 * Extract package name and version from an esm.sh URL.
 * 
 * @example
 * extractPackageInfoFromEsmUrl("https://esm.sh/zustand@5.0.10/esm/vanilla.d.mts")
 * // returns { packageName: "zustand", version: "5.0.10" }
 * 
 * extractPackageInfoFromEsmUrl("https://esm.sh/@tanstack/query-core@5.90.20/build/modern/index.d.ts")
 * // returns { packageName: "@tanstack/query-core", version: "5.90.20" }
 */
function extractPackageInfoFromEsmUrl(url: string): { packageName: string; version: string } | null {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const parts = pathname.split("/").filter(Boolean);
    
    if (parts.length === 0) return null;
    
    // Handle scoped packages (@scope/name@version)
    if (parts[0].startsWith("@")) {
      if (parts.length < 2) return null;
      // Extract package name and version
      const nameWithVersion = parts[1];
      const atIndex = nameWithVersion.lastIndexOf("@");
      if (atIndex === -1) {
        // No version in URL
        return { packageName: `${parts[0]}/${nameWithVersion}`, version: "latest" };
      }
      const name = nameWithVersion.slice(0, atIndex);
      const version = nameWithVersion.slice(atIndex + 1);
      return { packageName: `${parts[0]}/${name}`, version };
    }
    
    // Regular package (name@version)
    const nameWithVersion = parts[0];
    const atIndex = nameWithVersion.lastIndexOf("@");
    if (atIndex === -1) {
      return { packageName: nameWithVersion, version: "latest" };
    }
    const name = nameWithVersion.slice(0, atIndex);
    const version = nameWithVersion.slice(atIndex + 1);
    return { packageName: name, version };
  } catch {
    return null;
  }
}

/**
 * Extract the package name from an esm.sh URL.
 * 
 * @example
 * extractPackageFromEsmUrl("https://esm.sh/zustand@5.0.10/esm/vanilla.d.mts")
 * // returns "zustand"
 * 
 * extractPackageFromEsmUrl("https://esm.sh/@types/react@19.2.9/index.d.ts")
 * // returns "@types/react"
 */
function extractPackageFromEsmUrl(url: string): string | null {
  const info = extractPackageInfoFromEsmUrl(url);
  return info?.packageName ?? null;
}

/**
 * Extract a relative file path from an esm.sh URL.
 * Only returns a path if the URL is for the expected package.
 * 
 * @example
 * extractRelativePathFromEsmUrl("https://esm.sh/zustand@5.0.10/esm/vanilla.d.mts", "zustand")
 * // returns "vanilla.d.mts"
 * 
 * extractRelativePathFromEsmUrl("https://esm.sh/csstype@3.2.3/index.d.ts", "zustand")
 * // returns null (different package)
 */
function extractRelativePathFromEsmUrl(url: string, expectedPackage?: string): string | null {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    
    // Pattern: /{package}@{version}/{target}/{path}
    // e.g., /zustand@5.0.10/esm/vanilla.d.mts
    // We want to extract the path after the target directory (esm, esnext, etc.)
    
    // Split by / and find the file path portion
    const parts = pathname.split("/").filter(Boolean);
    
    if (parts.length === 0) return null;
    
    // Check if the URL is for the expected package
    if (expectedPackage) {
      const urlPackage = extractPackageFromEsmUrl(url);
      if (urlPackage !== expectedPackage) {
        // This URL is for a different package - don't follow it
        return null;
      }
    }
    
    // Find the package@version part (contains @)
    let startIndex = 0;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].includes("@")) {
        startIndex = i + 1;
        break;
      }
    }
    
    // Skip the target directory (esm, esnext, es2022, etc.)
    if (startIndex < parts.length) {
      const possibleTarget = parts[startIndex];
      if (["esm", "esnext", "es2022", "es2020", "es2015", "deno", "denonext"].includes(possibleTarget)) {
        startIndex++;
      }
    }
    
    // Join the remaining parts as the relative path
    const relativeParts = parts.slice(startIndex);
    if (relativeParts.length === 0) {
      return null;
    }
    
    return relativeParts.join("/");
  } catch {
    return null;
  }
}

/**
 * Rewrite absolute esm.sh URLs in content to relative paths.
 * 
 * This is needed because esm.sh sometimes rewrites relative imports to absolute URLs
 * in type definition files, but TypeScript expects relative imports to resolve
 * within the local filesystem.
 * 
 * Only rewrites URLs that are from the expected package. URLs from other packages
 * (like csstype) are left as-is since they won't be resolved locally anyway.
 * 
 * @example
 * // Original content:
 * export * from 'https://esm.sh/zustand@5.0.10/esm/vanilla.d.mts';
 * 
 * // After rewriting (from root directory):
 * export * from './vanilla.d.mts';
 * 
 * // After rewriting (from subdirectory "middleware"):
 * export * from '../vanilla.d.mts';
 */
function rewriteEsmUrlsToRelative(content: string, currentDir: string, expectedPackage?: string | null): string {
  // Match esm.sh URLs in import/export statements
  const urlPattern = /(['"])(https:\/\/esm\.sh\/[^'"]+)(['"])/g;
  
  return content.replace(urlPattern, (match, quote1, url, quote2) => {
    const extractedPath = extractRelativePathFromEsmUrl(url, expectedPackage ?? undefined);
    if (extractedPath) {
      // Same package - rewrite to relative path
      const relativePath = computeRelativePath(currentDir, extractedPath);
      return `${quote1}${relativePath}${quote2}`;
    }
    
    // Different package - rewrite to bare package specifier
    // This allows TypeScript to resolve it from node_modules
    const packageInfo = extractPackageInfoFromEsmUrl(url);
    if (packageInfo && packageInfo.packageName !== expectedPackage) {
      // External package - rewrite to bare package name
      // Special case: @types/foo should be rewritten to foo
      // because @types packages provide types FOR the original package
      const resolvedPackageName = fromTypesPackageName(packageInfo.packageName);
      return `${quote1}${resolvedPackageName}${quote2}`;
    }
    
    return match; // Keep original if we can't extract
  });
}

/**
 * Compute a relative path from one directory to a target file.
 * 
 * @example
 * computeRelativePath("", "vanilla.d.mts") // "./vanilla.d.mts"
 * computeRelativePath("middleware", "vanilla.d.mts") // "../vanilla.d.mts"
 * computeRelativePath("", "middleware/immer.d.mts") // "./middleware/immer.d.mts"
 */
function computeRelativePath(fromDir: string, toPath: string): string {
  if (!fromDir) {
    return "./" + toPath;
  }
  
  const fromParts = fromDir.split("/").filter(Boolean);
  const toParts = toPath.split("/").filter(Boolean);
  
  // Find common prefix
  let commonLength = 0;
  const minLength = Math.min(fromParts.length, toParts.length - 1); // -1 because last part is filename
  for (let i = 0; i < minLength; i++) {
    if (fromParts[i] === toParts[i]) {
      commonLength++;
    } else {
      break;
    }
  }
  
  // Go up from fromDir to common ancestor
  const upCount = fromParts.length - commonLength;
  const upParts = Array(upCount).fill("..");
  
  // Go down from common ancestor to target
  const downParts = toParts.slice(commonLength);
  
  if (upParts.length === 0) {
    return "./" + downParts.join("/");
  }
  
  return [...upParts, ...downParts].join("/");
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
