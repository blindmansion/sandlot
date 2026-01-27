/**
 * Package management for sandbox environments.
 *
 * Provides npm-like package installation using esm.sh CDN:
 * - Fetches TypeScript type definitions for editor/typecheck support
 * - Stores installed versions in package.json
 * - Resolves bare imports to CDN URLs at bundle time
 * - Supports @types/* packages (fetches package content as types)
 * - Supports subpath exports (react-dom/client, react/jsx-runtime)
 *
 * @example
 * ```ts
 * // Install a package
 * const result = await installPackage(fs, "react");
 * // result: { name: "react", version: "18.2.0", typesInstalled: true }
 *
 * // Get installed packages
 * const manifest = await getPackageManifest(fs);
 * // manifest.dependencies: { "react": "18.2.0" }
 *
 * // Resolve import to CDN URL
 * const url = resolveToEsmUrl("react", "18.2.0");
 * // url: "https://esm.sh/react@18.2.0"
 * ```
 */

import type { IFileSystem } from "just-bash/browser";

/**
 * CDN base URL for esm.sh
 */
const ESM_CDN_BASE = "https://esm.sh";

/**
 * Known subpaths that should be auto-fetched for common packages.
 * These are subpath exports that are commonly used and need separate type definitions.
 */
const KNOWN_SUBPATHS: Record<string, string[]> = {
  react: ["jsx-runtime", "jsx-dev-runtime"],
  "react-dom": ["client", "server"],
};

/**
 * Package manifest (subset of package.json)
 */
export interface PackageManifest {
  dependencies: Record<string, string>;
}

/**
 * Cache for storing fetched type definitions.
 * Used to avoid redundant network fetches when multiple sandboxes
 * install the same packages.
 */
export interface TypesCache {
  /**
   * Get cached type definitions for a package version.
   * Returns null if not cached.
   */
  get(name: string, version: string): Map<string, string> | null;

  /**
   * Store type definitions in the cache.
   */
  set(name: string, version: string, types: Map<string, string>): void;

  /**
   * Check if a package version is cached.
   */
  has(name: string, version: string): boolean;

  /**
   * Remove a package version from the cache.
   */
  delete(name: string, version: string): boolean;

  /**
   * Clear all cached entries.
   */
  clear(): void;
}

/**
 * In-memory implementation of TypesCache.
 * Suitable for sharing across multiple sandboxes within a session.
 */
export class InMemoryTypesCache implements TypesCache {
  private cache = new Map<string, Map<string, string>>();

  private key(name: string, version: string): string {
    return `${name}@${version}`;
  }

  get(name: string, version: string): Map<string, string> | null {
    return this.cache.get(this.key(name, version)) ?? null;
  }

  set(name: string, version: string, types: Map<string, string>): void {
    this.cache.set(this.key(name, version), types);
  }

  has(name: string, version: string): boolean {
    return this.cache.has(this.key(name, version));
  }

  delete(name: string, version: string): boolean {
    return this.cache.delete(this.key(name, version));
  }

  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the number of cached packages (for diagnostics).
   */
  get size(): number {
    return this.cache.size;
  }
}

/**
 * Result of installing a package
 */
export interface InstallResult {
  /** Package name */
  name: string;
  /** Resolved version */
  version: string;
  /** Whether type definitions were installed */
  typesInstalled: boolean;
  /** Number of type definition files installed */
  typeFilesCount: number;
  /** Error message if types failed (but package still usable) */
  typesError?: string;
  /** Whether types were loaded from cache */
  fromCache?: boolean;
}

/**
 * Options for installing a package
 */
export interface InstallOptions {
  /**
   * Cache to use for storing/retrieving type definitions.
   * When provided, avoids redundant network fetches for packages
   * that have already been installed in other sandboxes.
   */
  cache?: TypesCache;
}

/**
 * Package info from esm.sh headers
 */
interface EsmPackageInfo {
  /** Resolved version (e.g., "18.2.0") */
  version: string;
  /** URL to TypeScript types, if available */
  typesUrl?: string;
}

/**
 * Path to package.json in the virtual filesystem
 */
const PACKAGE_JSON_PATH = "/package.json";

/**
 * Parse package specifier into name and version
 * Examples:
 *   "react" -> { name: "react", version: undefined }
 *   "react@18" -> { name: "react", version: "18" }
 *   "@tanstack/react-query@5" -> { name: "@tanstack/react-query", version: "5" }
 */
export function parsePackageSpec(spec: string): { name: string; version?: string } {
  // Handle scoped packages: @scope/name@version
  if (spec.startsWith("@")) {
    const slashIndex = spec.indexOf("/");
    if (slashIndex === -1) {
      return { name: spec };
    }
    const afterSlash = spec.slice(slashIndex + 1);
    const atIndex = afterSlash.indexOf("@");
    if (atIndex === -1) {
      return { name: spec };
    }
    return {
      name: spec.slice(0, slashIndex + 1 + atIndex),
      version: afterSlash.slice(atIndex + 1),
    };
  }

  // Regular packages: name@version
  const atIndex = spec.indexOf("@");
  if (atIndex === -1) {
    return { name: spec };
  }
  return {
    name: spec.slice(0, atIndex),
    version: spec.slice(atIndex + 1),
  };
}

/**
 * Check if a package is a @types/* package
 */
function isTypesPackage(name: string): boolean {
  return name.startsWith("@types/");
}

/**
 * Extract version from esm.sh URL
 * Handles various URL formats including scoped packages
 */
function extractVersionFromUrl(url: string, packageName: string): string | null {
  // Try exact package name match first
  const exactRegex = new RegExp(`${escapeRegExp(packageName)}@([^/]+)`);
  const exactMatch = url.match(exactRegex);
  if (exactMatch?.[1]) {
    return exactMatch[1];
  }

  // For scoped packages, try matching after the scope
  if (packageName.startsWith("@")) {
    const scopedParts = packageName.split("/");
    if (scopedParts.length === 2 && scopedParts[1]) {
      // Try matching just the package part after scope
      const partialRegex = new RegExp(`${escapeRegExp(scopedParts[1])}@([^/]+)`);
      const partialMatch = url.match(partialRegex);
      if (partialMatch?.[1]) {
        return partialMatch[1];
      }
    }
  }

  // Generic fallback: look for any @version pattern at the end of a path segment
  const genericMatch = url.match(/@(\d+\.\d+\.\d+[^/]*)/);
  if (genericMatch?.[1]) {
    return genericMatch[1];
  }

  return null;
}

/**
 * Fetch the latest version of a package from npm registry
 */
async function fetchVersionFromNpm(name: string): Promise<string> {
  const registryUrl = `https://registry.npmjs.org/${name}/latest`;
  const response = await fetch(registryUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch version from npm: ${response.status}`);
  }
  const data = await response.json();
  return data.version;
}

/**
 * Extract version from esm.sh response headers
 * esm.sh includes version info in various headers
 */
function extractVersionFromHeaders(headers: Headers, packageName: string): string | null {
  // Try x-esm-id header (contains the resolved module path with version)
  const esmId = headers.get("x-esm-id");
  if (esmId) {
    const version = extractVersionFromUrl(esmId, packageName);
    if (version) return version;
  }

  // Try extracting from X-TypeScript-Types header
  // e.g., "/@types/react@18.3.1/index.d.ts" - but note this is @types version
  // We can use it as a hint for the main package version
  const typesHeader = headers.get("X-TypeScript-Types");
  if (typesHeader) {
    // Extract version - for react, types header might have /v18.3.1/ or similar
    const versionMatch = typesHeader.match(/@(\d+\.\d+\.\d+[^/]*)/);
    if (versionMatch?.[1]) {
      return versionMatch[1];
    }
  }

  return null;
}

/**
 * Fetch package info from esm.sh (version and types URL)
 */
async function fetchPackageInfo(name: string, version?: string, subpath?: string): Promise<EsmPackageInfo> {
  // Build URL with optional subpath
  let url = version ? `${ESM_CDN_BASE}/${name}@${version}` : `${ESM_CDN_BASE}/${name}`;
  if (subpath) {
    url += `/${subpath}`;
  }

  const response = await fetch(url, { method: "HEAD" });
  if (!response.ok) {
    throw new Error(`Package not found: ${name}${version ? `@${version}` : ""}${subpath ? `/${subpath}` : ""}`);
  }

  // Extract version from response URL or headers
  const resolvedUrl = response.url;
  let resolvedVersion = extractVersionFromUrl(resolvedUrl, name);

  // Try headers if URL extraction failed
  if (!resolvedVersion) {
    resolvedVersion = extractVersionFromHeaders(response.headers, name);
  }

  // Fall back to provided version if it's specific
  if (!resolvedVersion && version && version !== "latest") {
    resolvedVersion = version;
  }

  // Last resort: query npm registry for latest version
  if (!resolvedVersion) {
    try {
      resolvedVersion = await fetchVersionFromNpm(name);
    } catch (err) {
      console.warn(`Could not resolve version for ${name}:`, err);
      resolvedVersion = "latest"; // Absolute last resort
    }
  }

  // Get TypeScript types URL from header
  const typesUrl = response.headers.get("X-TypeScript-Types") ?? undefined;

  return {
    version: resolvedVersion,
    typesUrl: typesUrl ? new URL(typesUrl, resolvedUrl).href : undefined,
  };
}

/**
 * Escape special regex characters
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fetch type definitions from esm.sh
 * Returns a map of file paths to contents
 */
async function fetchTypeDefinitions(
  typesUrl: string,
  packageName: string
): Promise<Map<string, string>> {
  const types = new Map<string, string>();

  try {
    const response = await fetch(typesUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch types: ${response.status}`);
    }

    const content = await response.text();

    // Store as index.d.ts for the package
    const typePath = `/node_modules/${packageName}/index.d.ts`;
    types.set(typePath, content);

    // Parse and fetch referenced types (similar to ts-libs.ts)
    const refs = parseTypeReferences(content);
    await fetchReferencedTypes(refs, typesUrl, packageName, types);
  } catch (err) {
    console.warn(`Failed to fetch types for ${packageName}:`, err);
    throw err;
  }

  return types;
}

/**
 * Parse `/// <reference path="..." />` and `/// <reference types="..." />` from .d.ts
 */
function parseTypeReferences(content: string): { paths: string[]; types: string[] } {
  const paths: string[] = [];
  const types: string[] = [];

  // Match /// <reference path="..." />
  const pathRegex = /\/\/\/\s*<reference\s+path="([^"]+)"\s*\/>/g;
  let match;
  while ((match = pathRegex.exec(content)) !== null) {
    if (match[1]) paths.push(match[1]);
  }

  // Match /// <reference types="..." />
  const typesRegex = /\/\/\/\s*<reference\s+types="([^"]+)"\s*\/>/g;
  while ((match = typesRegex.exec(content)) !== null) {
    if (match[1]) types.push(match[1]);
  }

  return { paths, types };
}

/**
 * Fetch referenced type files recursively
 */
async function fetchReferencedTypes(
  refs: { paths: string[]; types: string[] },
  baseUrl: string,
  packageName: string,
  collected: Map<string, string>,
  visited = new Set<string>()
): Promise<void> {
  // Handle path references (relative files)
  for (const pathRef of refs.paths) {
    const refUrl = new URL(pathRef, baseUrl).href;
    if (visited.has(refUrl)) continue;
    visited.add(refUrl);

    try {
      const response = await fetch(refUrl);
      if (!response.ok) continue;

      const content = await response.text();

      // Determine the file path in node_modules
      const fileName = pathRef.split("/").pop() ?? "types.d.ts";
      const typePath = `/node_modules/${packageName}/${fileName}`;
      collected.set(typePath, content);

      // Recursively fetch references
      const nestedRefs = parseTypeReferences(content);
      await fetchReferencedTypes(nestedRefs, refUrl, packageName, collected, visited);
    } catch {
      // Skip failed references
    }
  }

  // Handle types references (other packages)
  // These would require installing those packages - skip for now
  // The user can install them explicitly if needed
}

/**
 * Fetch type definitions for a subpath export (e.g., react-dom/client)
 * Returns a map of file paths to contents
 */
async function fetchSubpathTypes(
  packageName: string,
  subpath: string,
  version: string
): Promise<Map<string, string>> {
  const types = new Map<string, string>();

  try {
    // Fetch the subpath to get its types URL
    const info = await fetchPackageInfo(packageName, version, subpath);

    if (!info.typesUrl) {
      // No types available for this subpath - that's okay, not all subpaths have types
      return types;
    }

    const response = await fetch(info.typesUrl);
    if (!response.ok) {
      return types;
    }

    const content = await response.text();

    // Store at the correct subpath location
    // e.g., /node_modules/react-dom/client.d.ts or /node_modules/react-dom/client/index.d.ts
    const typePath = `/node_modules/${packageName}/${subpath}.d.ts`;
    types.set(typePath, content);

    // Also create a directory version for imports like "react-dom/client"
    // TypeScript might look for /node_modules/react-dom/client/index.d.ts
    const indexTypePath = `/node_modules/${packageName}/${subpath}/index.d.ts`;
    types.set(indexTypePath, content);

    // Parse and fetch referenced types
    const refs = parseTypeReferences(content);
    await fetchReferencedTypes(refs, info.typesUrl, packageName, types);
  } catch (err) {
    // Subpath type fetching is best-effort
    console.warn(`Failed to fetch types for ${packageName}/${subpath}:`, err);
  }

  return types;
}

/**
 * Fetch types for a @types/* package
 * These packages ARE the type definitions, so we fetch the package content directly
 */
async function fetchTypesPackageContent(
  name: string,
  version?: string
): Promise<{ version: string; types: Map<string, string> }> {
  // e.g., @types/react -> fetch https://esm.sh/@types/react/index.d.ts
  const url = version
    ? `${ESM_CDN_BASE}/${name}@${version}`
    : `${ESM_CDN_BASE}/${name}`;

  // First, get the resolved version via HEAD request
  const headResponse = await fetch(url, { method: "HEAD" });
  if (!headResponse.ok) {
    throw new Error(`Package not found: ${name}${version ? `@${version}` : ""}`);
  }

  const resolvedVersion = extractVersionFromUrl(headResponse.url, name) ?? version ?? "latest";

  // Now fetch the actual index.d.ts content
  const indexUrl = `${ESM_CDN_BASE}/${name}@${resolvedVersion}/index.d.ts`;
  const response = await fetch(indexUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch types from ${name}: ${response.status}`);
  }

  const content = await response.text();
  const types = new Map<string, string>();

  // Store as index.d.ts for the @types package
  const typePath = `/node_modules/${name}/index.d.ts`;
  types.set(typePath, content);

  // Parse and fetch referenced types
  const refs = parseTypeReferences(content);

  // For path references, we need to fetch them from the same package
  for (const pathRef of refs.paths) {
    try {
      const refUrl = new URL(pathRef, indexUrl).href;
      const refResponse = await fetch(refUrl);
      if (refResponse.ok) {
        const refContent = await refResponse.text();
        // Determine the file path - preserve the relative structure
        const fileName = pathRef.startsWith("./") ? pathRef.slice(2) : pathRef;
        const refTypePath = `/node_modules/${name}/${fileName}`;
        types.set(refTypePath, refContent);
      }
    } catch {
      // Skip failed references
    }
  }

  return { version: resolvedVersion, types };
}

/**
 * Read the package manifest from the filesystem
 */
export async function getPackageManifest(fs: IFileSystem): Promise<PackageManifest> {
  try {
    if (await fs.exists(PACKAGE_JSON_PATH)) {
      const content = await fs.readFile(PACKAGE_JSON_PATH);
      const parsed = JSON.parse(content);
      return {
        dependencies: parsed.dependencies ?? {},
      };
    }
  } catch {
    // Invalid JSON or read error - return empty manifest
  }
  return { dependencies: {} };
}

/**
 * Write the package manifest to the filesystem
 */
async function savePackageManifest(
  fs: IFileSystem,
  manifest: PackageManifest
): Promise<void> {
  let existing: Record<string, unknown> = {};

  try {
    if (await fs.exists(PACKAGE_JSON_PATH)) {
      const content = await fs.readFile(PACKAGE_JSON_PATH);
      existing = JSON.parse(content);
    }
  } catch {
    // Start fresh if invalid
  }

  const updated = {
    ...existing,
    dependencies: manifest.dependencies,
  };

  await fs.writeFile(PACKAGE_JSON_PATH, JSON.stringify(updated, null, 2));
}

/**
 * Install a package from npm via esm.sh
 *
 * This fetches type definitions and stores them in the virtual filesystem,
 * then updates package.json with the installed version.
 *
 * Special handling:
 * - @types/* packages: Fetches package content directly as types
 * - Known packages (react, react-dom): Auto-fetches subpath types
 *
 * @param fs - The virtual filesystem
 * @param packageSpec - Package name with optional version (e.g., "react", "lodash@4")
 * @returns Install result with version and type info
 *
 * @example
 * ```ts
 * // Install latest version
 * await installPackage(fs, "react");
 *
 * // Install specific version
 * await installPackage(fs, "lodash@4.17.21");
 *
 * // Install scoped package
 * await installPackage(fs, "@tanstack/react-query@5");
 *
 * // Install @types package
 * await installPackage(fs, "@types/lodash");
 * ```
 */
export async function installPackage(
  fs: IFileSystem,
  packageSpec: string,
  options?: InstallOptions
): Promise<InstallResult> {
  const { name, version } = parsePackageSpec(packageSpec);
  const { cache } = options ?? {};

  // Handle @types/* packages specially - they ARE the type definitions
  if (isTypesPackage(name)) {
    return installTypesPackage(fs, name, version, cache);
  }

  // Fetch package info from esm.sh (need version for cache key)
  const info = await fetchPackageInfo(name, version);

  // Ensure node_modules directory for this package exists
  const packageDir = `/node_modules/${name}`;
  await ensureDir(fs, packageDir);

  // Create a minimal package.json for TypeScript resolution
  const packageJsonPath = `${packageDir}/package.json`;
  const packageJson = {
    name,
    version: info.version,
    types: "./index.d.ts",
    main: "./index.js",
  };
  await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));

  // Try to get types from cache first
  let typeFiles: Map<string, string> | null = null;
  let fromCache = false;

  if (cache) {
    typeFiles = cache.get(name, info.version);
    if (typeFiles) {
      fromCache = true;
    }
  }

  // If not cached, fetch from network
  let typesError: string | undefined;
  if (!typeFiles) {
    typeFiles = new Map<string, string>();

    if (info.typesUrl) {
      try {
        const mainTypes = await fetchTypeDefinitions(info.typesUrl, name);
        for (const [path, content] of mainTypes) {
          typeFiles.set(path, content);
        }
      } catch (err) {
        typesError = err instanceof Error ? err.message : String(err);
      }
    } else {
      typesError = "No TypeScript types available from esm.sh";
    }

    // Fetch types for known subpaths (e.g., react-dom/client, react/jsx-runtime)
    const knownSubpaths = KNOWN_SUBPATHS[name];
    if (knownSubpaths && knownSubpaths.length > 0) {
      const subpathResults = await Promise.allSettled(
        knownSubpaths.map((subpath) => fetchSubpathTypes(name, subpath, info.version))
      );

      for (const result of subpathResults) {
        if (result.status === "fulfilled") {
          for (const [path, content] of result.value) {
            typeFiles.set(path, content);
          }
        }
      }
    }

    // Store in cache for other sandboxes
    if (cache && typeFiles.size > 0) {
      cache.set(name, info.version, typeFiles);
    }
  }

  // Write type files to VFS
  for (const [path, content] of typeFiles) {
    const dir = path.substring(0, path.lastIndexOf("/"));
    await ensureDir(fs, dir);
    await fs.writeFile(path, content);
  }

  // Update package.json
  const manifest = await getPackageManifest(fs);
  manifest.dependencies[name] = info.version;
  await savePackageManifest(fs, manifest);

  return {
    name,
    version: info.version,
    typesInstalled: typeFiles.size > 0,
    typeFilesCount: typeFiles.size,
    typesError,
    fromCache,
  };
}

/**
 * Install a @types/* package
 * These packages ARE the type definitions, so we fetch the package content directly
 */
async function installTypesPackage(
  fs: IFileSystem,
  name: string,
  version?: string,
  cache?: TypesCache
): Promise<InstallResult> {
  // For @types packages, we need to resolve the version first to check the cache
  // We'll do a HEAD request to get the resolved version
  const url = version
    ? `${ESM_CDN_BASE}/${name}@${version}`
    : `${ESM_CDN_BASE}/${name}`;
  
  const headResponse = await fetch(url, { method: "HEAD" });
  if (!headResponse.ok) {
    throw new Error(`Package not found: ${name}${version ? `@${version}` : ""}`);
  }
  
  const resolvedVersion = extractVersionFromUrl(headResponse.url, name) ?? version ?? "latest";

  // Check cache first
  let types: Map<string, string> | null = null;
  let fromCache = false;

  if (cache) {
    types = cache.get(name, resolvedVersion);
    if (types) {
      fromCache = true;
    }
  }

  // If not cached, fetch from network
  if (!types) {
    const result = await fetchTypesPackageContent(name, version);
    types = result.types;

    // Store in cache
    if (cache && types.size > 0) {
      cache.set(name, resolvedVersion, types);
    }
  }

  // Ensure node_modules directory for this package exists
  const packageDir = `/node_modules/${name}`;
  await ensureDir(fs, packageDir);

  // Create a minimal package.json
  const packageJsonPath = `${packageDir}/package.json`;
  const packageJson = {
    name,
    version: resolvedVersion,
    types: "./index.d.ts",
  };
  await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));

  // Write all type files
  for (const [path, content] of types) {
    const dir = path.substring(0, path.lastIndexOf("/"));
    await ensureDir(fs, dir);
    await fs.writeFile(path, content);
  }

  // Update package.json manifest
  const manifest = await getPackageManifest(fs);
  manifest.dependencies[name] = resolvedVersion;
  await savePackageManifest(fs, manifest);

  return {
    name,
    version: resolvedVersion,
    typesInstalled: types.size > 0,
    typeFilesCount: types.size,
    fromCache,
  };
}

/**
 * Ensure a directory exists, creating parent directories as needed
 */
async function ensureDir(fs: IFileSystem, path: string): Promise<void> {
  if (path === "/" || path === "") return;

  if (await fs.exists(path)) {
    const stat = await fs.stat(path);
    if (stat.isDirectory) return;
  }

  // Ensure parent exists first
  const parent = path.substring(0, path.lastIndexOf("/")) || "/";
  await ensureDir(fs, parent);

  // Create this directory
  await fs.mkdir(path);
}

/**
 * Uninstall a package
 *
 * Removes the package from package.json and deletes type definitions.
 */
export async function uninstallPackage(
  fs: IFileSystem,
  packageName: string
): Promise<boolean> {
  const manifest = await getPackageManifest(fs);

  if (!(packageName in manifest.dependencies)) {
    return false;
  }

  // Remove from manifest
  delete manifest.dependencies[packageName];
  await savePackageManifest(fs, manifest);

  // Remove type definitions
  const typesPath = `/node_modules/${packageName}`;
  if (await fs.exists(typesPath)) {
    await removePath(fs, typesPath);
  }

  return true;
}

/**
 * Recursively remove a directory or file
 */
async function removePath(fs: IFileSystem, path: string): Promise<void> {
  if (!(await fs.exists(path))) return;
  await fs.rm(path, { recursive: true, force: true });
}

/**
 * Resolve a bare import to an esm.sh URL
 *
 * @param importPath - The import path (e.g., "react", "lodash/debounce")
 * @param installedPackages - Map of package name to version
 * @returns The CDN URL, or null if package not installed
 *
 * @example
 * ```ts
 * const packages = { "react": "18.2.0", "lodash-es": "4.17.21" };
 *
 * resolveToEsmUrl("react", packages);
 * // "https://esm.sh/react@18.2.0"
 *
 * resolveToEsmUrl("lodash-es/debounce", packages);
 * // "https://esm.sh/lodash-es@4.17.21/debounce"
 *
 * resolveToEsmUrl("unknown", packages);
 * // null
 * ```
 */
export function resolveToEsmUrl(
  importPath: string,
  installedPackages: Record<string, string>
): string | null {
  // Parse the import path to get package name and subpath
  const { packageName, subpath } = parseImportPath(importPath);

  const version = installedPackages[packageName];
  if (!version) {
    return null;
  }

  const baseUrl = `${ESM_CDN_BASE}/${packageName}@${version}`;
  return subpath ? `${baseUrl}/${subpath}` : baseUrl;
}

/**
 * Parse an import path into package name and subpath
 *
 * @example
 * parseImportPath("react") // { packageName: "react", subpath: undefined }
 * parseImportPath("lodash/debounce") // { packageName: "lodash", subpath: "debounce" }
 * parseImportPath("@tanstack/react-query") // { packageName: "@tanstack/react-query", subpath: undefined }
 * parseImportPath("@tanstack/react-query/devtools") // { packageName: "@tanstack/react-query", subpath: "devtools" }
 */
export function parseImportPath(importPath: string): {
  packageName: string;
  subpath?: string;
} {
  // Handle scoped packages
  if (importPath.startsWith("@")) {
    const parts = importPath.split("/");
    if (parts.length >= 2) {
      const packageName = `${parts[0]}/${parts[1]}`;
      const subpath = parts.slice(2).join("/") || undefined;
      return { packageName, subpath };
    }
    return { packageName: importPath };
  }

  // Regular packages
  const slashIndex = importPath.indexOf("/");
  if (slashIndex === -1) {
    return { packageName: importPath };
  }

  return {
    packageName: importPath.slice(0, slashIndex),
    subpath: importPath.slice(slashIndex + 1),
  };
}

/**
 * List all installed packages
 */
export async function listPackages(
  fs: IFileSystem
): Promise<Array<{ name: string; version: string }>> {
  const manifest = await getPackageManifest(fs);
  return Object.entries(manifest.dependencies).map(([name, version]) => ({
    name,
    version,
  }));
}
