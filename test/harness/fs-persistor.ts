/**
 * Filesystem-backed persistor for tests.
 *
 * Persists cache data to the filesystem in a structured folder layout:
 *
 * test/.cache/
 * ├── ts-libs/
 * │   └── {version}/
 * │       └── {libName}.d.ts
 * └── package-types/
 *     └── {package}@{version}/
 *         ├── meta.json         (packageName, version, fromTypesPackage)
 *         └── files/
 *             └── {relativePath}.d.ts
 */

import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ICache, IPersistor, ResolvedTypes } from "sandlot";

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_CACHE_DIR = join(import.meta.dir, "..", ".cache");

// =============================================================================
// Filesystem Cache for TypeScript Libs
// =============================================================================

/**
 * Cache for TypeScript lib files.
 * Stores each lib as a separate .d.ts file.
 *
 * Key format: `ts:${version}:${libName}` (e.g., "ts:5.9.3:dom")
 * File path: `ts-libs/${version}/${libName}.d.ts`
 */
class TsLibsCache implements ICache<string> {
  constructor(private baseDir: string) {
    mkdirSync(baseDir, { recursive: true });
  }

  private parseKey(key: string): { version: string; libName: string } | null {
    // Key format: ts:5.9.3:dom
    const match = key.match(/^ts:([^:]+):(.+)$/);
    if (!match || !match[1] || !match[2]) return null;
    return { version: match[1], libName: match[2] };
  }

  private getFilePath(key: string): string | null {
    const parsed = this.parseKey(key);
    if (!parsed) return null;
    // Sanitize libName to be filesystem-safe
    const safeName = parsed.libName.replace(/[^a-zA-Z0-9.-]/g, "_");
    return join(this.baseDir, parsed.version, `${safeName}.d.ts`);
  }

  async get(key: string): Promise<string | null> {
    const filePath = this.getFilePath(key);
    if (!filePath) return null;

    try {
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return await file.text();
      }
    } catch {
      // File doesn't exist or read error
    }
    return null;
  }

  async set(key: string, value: string): Promise<void> {
    const filePath = this.getFilePath(key);
    if (!filePath) return;

    mkdirSync(dirname(filePath), { recursive: true });
    await Bun.write(filePath, value);
  }

  async has(key: string): Promise<boolean> {
    const filePath = this.getFilePath(key);
    if (!filePath) return false;

    try {
      const file = Bun.file(filePath);
      return await file.exists();
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.getFilePath(key);
    if (!filePath) return;

    try {
      rmSync(filePath);
    } catch {
      // File doesn't exist
    }
  }

  async clear(): Promise<void> {
    try {
      rmSync(this.baseDir, { recursive: true, force: true });
      mkdirSync(this.baseDir, { recursive: true });
    } catch {
      // Directory doesn't exist
    }
  }
}

// =============================================================================
// Filesystem Cache for Package Types
// =============================================================================

/**
 * Metadata file structure for package types.
 */
interface PackageTypesMeta {
  packageName: string;
  version: string;
  fromTypesPackage: boolean;
  peerTypeDeps?: Array<{ packageName: string; version: string }>;
}

/**
 * Cache for npm package type definitions.
 * Stores each package in its own directory with versions as subdirectories:
 * - {package}/{version}/meta.json: Package metadata
 * - {package}/{version}/files/: Directory containing all .d.ts files
 *
 * Key format: `types:${package}@${version}`
 * Directory: `package-types/{package}/{version}/`
 *
 * Example:
 *   types:lodash-es@4.17.21 -> package-types/lodash-es/4.17.21/
 *   types:@types/lodash@4.17.0 -> package-types/@types--lodash/4.17.0/
 */
class PackageTypesCache implements ICache<ResolvedTypes> {
  constructor(private baseDir: string) {
    mkdirSync(baseDir, { recursive: true });
  }

  private parseKey(key: string): { packageName: string; version: string } | null {
    // Key format: types:lodash@4.17.21 or types:@types/lodash@4.17.0
    const match = key.match(/^types:(.+)@([^@]+)$/);
    if (!match || !match[1] || !match[2]) return null;
    return { packageName: match[1], version: match[2] };
  }

  private getPackageDir(key: string): string | null {
    const parsed = this.parseKey(key);
    if (!parsed) return null;
    // Replace / with -- for scoped packages (e.g., @types/lodash -> @types--lodash)
    const safePackageName = parsed.packageName.replace(/\//g, "--");
    return join(this.baseDir, safePackageName, parsed.version);
  }

  async get(key: string): Promise<ResolvedTypes | null> {
    const packageDir = this.getPackageDir(key);
    if (!packageDir) return null;

    try {
      const metaPath = join(packageDir, "meta.json");
      const metaFile = Bun.file(metaPath);

      if (!(await metaFile.exists())) {
        return null;
      }

      const meta: PackageTypesMeta = await metaFile.json();
      const filesDir = join(packageDir, "files");

      // Read all .d.ts files from the files directory
      const files: Record<string, string> = {};

      if (existsSync(filesDir)) {
        await this.readFilesRecursively(filesDir, filesDir, files);
      }

      return {
        packageName: meta.packageName,
        version: meta.version,
        files,
        fromTypesPackage: meta.fromTypesPackage,
        peerTypeDeps: meta.peerTypeDeps,
      };
    } catch {
      return null;
    }
  }

  /**
   * Recursively read all files from a directory into a flat map.
   */
  private async readFilesRecursively(
    dir: string,
    baseDir: string,
    files: Record<string, string>
  ): Promise<void> {
    const entries = readdirSync(dir);

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        await this.readFilesRecursively(fullPath, baseDir, files);
      } else {
        // Get relative path from baseDir
        const relativePath = fullPath.slice(baseDir.length + 1);
        const file = Bun.file(fullPath);
        files[relativePath] = await file.text();
      }
    }
  }

  async set(key: string, value: ResolvedTypes): Promise<void> {
    const packageDir = this.getPackageDir(key);
    if (!packageDir) return;

    // Clean up existing directory if it exists
    rmSync(packageDir, { recursive: true, force: true });
    mkdirSync(packageDir, { recursive: true });

    // Write meta.json
    const meta: PackageTypesMeta = {
      packageName: value.packageName,
      version: value.version,
      fromTypesPackage: value.fromTypesPackage,
      peerTypeDeps: value.peerTypeDeps,
    };
    await Bun.write(join(packageDir, "meta.json"), JSON.stringify(meta, null, 2));

    // Write all .d.ts files
    const filesDir = join(packageDir, "files");

    for (const [relativePath, content] of Object.entries(value.files)) {
      const filePath = join(filesDir, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      await Bun.write(filePath, content);
    }
  }

  async has(key: string): Promise<boolean> {
    const packageDir = this.getPackageDir(key);
    if (!packageDir) return false;

    try {
      const metaFile = Bun.file(join(packageDir, "meta.json"));
      return await metaFile.exists();
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const packageDir = this.getPackageDir(key);
    if (!packageDir) return;

    try {
      rmSync(packageDir, { recursive: true, force: true });
    } catch {
      // Directory doesn't exist
    }
  }

  async clear(): Promise<void> {
    try {
      rmSync(this.baseDir, { recursive: true, force: true });
      mkdirSync(this.baseDir, { recursive: true });
    } catch {
      // Directory doesn't exist
    }
  }
}

// =============================================================================
// Filesystem Persistor
// =============================================================================

/**
 * Filesystem-backed persistor for tests.
 *
 * Stores cache data in a structured folder layout under the test directory.
 * This allows cache data to persist across test runs, speeding up repeated
 * test execution by avoiding redundant network fetches.
 *
 * @example
 * ```ts
 * import { createFsPersistor } from "./harness/fs-persistor.ts";
 *
 * const persistor = createFsPersistor();
 * const sandlot = await createNodeSandlot({ persistor });
 * ```
 */
export class FsPersistor implements IPersistor {
  readonly tsLibs: ICache<string>;
  readonly packageTypes: ICache<ResolvedTypes>;

  constructor(cacheDir: string = DEFAULT_CACHE_DIR) {
    mkdirSync(cacheDir, { recursive: true });
    this.tsLibs = new TsLibsCache(join(cacheDir, "ts-libs"));
    this.packageTypes = new PackageTypesCache(join(cacheDir, "package-types"));
  }

  /**
   * Clear all cached data.
   */
  async clearAll(): Promise<void> {
    await this.tsLibs.clear();
    await this.packageTypes.clear();
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a filesystem-backed persistor for tests.
 *
 * @param cacheDir - Directory to store cache files. Defaults to `test/.cache/`.
 *
 * @example
 * ```ts
 * const persistor = createFsPersistor();
 * const sandlot = await createNodeSandlot({ persistor });
 * ```
 */
export function createFsPersistor(cacheDir?: string): FsPersistor {
  return new FsPersistor(cacheDir);
}
