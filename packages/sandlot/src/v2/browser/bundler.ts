import type * as EsbuildTypes from "esbuild-wasm";
import type {
  IBundler,
  ISharedModuleRegistry,
  BundleOptions,
  BundleResult,
  BundleWarning,
  IFileSystem,
} from "../types";

/**
 * esbuild-wasm version - should match what's in package.json
 */
const ESBUILD_VERSION = "0.27.2";

export interface EsbuildWasmBundlerOptions {
  /**
   * URL to the esbuild WASM file.
   * @default "https://unpkg.com/esbuild-wasm@{version}/esbuild.wasm"
   */
  wasmUrl?: string;

  /**
   * URL to load esbuild-wasm module from.
   * @default "https://esm.sh/esbuild-wasm@{version}"
   */
  esbuildUrl?: string;

  /**
   * Base URL for CDN imports.
   * npm imports like "lodash" are rewritten to "{cdnBaseUrl}/lodash@{version}".
   * @default "https://esm.sh"
   */
  cdnBaseUrl?: string;

  /**
   * Whether to initialize immediately on construction.
   * If false, initialization happens lazily on first bundle() call.
   * @default false
   */
  eagerInit?: boolean;
}

/**
 * Browser bundler implementation using esbuild-wasm.
 *
 * Handles WASM initialization internally. The first bundle() call
 * will wait for initialization if not already complete.
 *
 * @example
 * ```ts
 * const bundler = new EsbuildWasmBundler();
 * await bundler.initialize();
 *
 * const result = await bundler.bundle({
 *   fs: myFilesystem,
 *   entryPoint: "/src/index.ts",
 * });
 * ```
 */
export class EsbuildWasmBundler implements IBundler {
  private options: EsbuildWasmBundlerOptions;
  private initPromise: Promise<void> | null = null;
  private initialized = false;
  private esbuild: typeof EsbuildTypes | null = null;

  constructor(options: EsbuildWasmBundlerOptions = {}) {
    this.options = {
      cdnBaseUrl: "https://esm.sh",
      ...options,
    };

    if (options.eagerInit) {
      this.initPromise = this.initialize();
    }
  }

  /**
   * Initialize the esbuild WASM module.
   * Called automatically on first bundle() if not already initialized.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.doInitialize();
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    // Check for cross-origin isolation (needed for SharedArrayBuffer)
    this.checkCrossOriginIsolation();

    // Load esbuild-wasm from CDN
    const esbuildUrl =
      this.options.esbuildUrl ?? `https://esm.sh/esbuild-wasm@${ESBUILD_VERSION}`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* @vite-ignore */ esbuildUrl);
    this.esbuild = mod.default ?? mod;

    if (typeof this.esbuild?.initialize !== "function") {
      throw new Error(
        "Failed to load esbuild-wasm: initialize function not found"
      );
    }

    // Initialize with WASM binary
    const wasmUrl =
      this.options.wasmUrl ??
      `https://unpkg.com/esbuild-wasm@${ESBUILD_VERSION}/esbuild.wasm`;

    await this.esbuild.initialize({ wasmURL: wasmUrl });
    this.initialized = true;
  }

  private checkCrossOriginIsolation(): void {
    if (typeof window === "undefined") return;

    if (!window.crossOriginIsolated) {
      console.warn(
        "[sandlot] Cross-origin isolation is not enabled. " +
          "esbuild-wasm may have reduced performance or fail on some browsers.\n" +
          "To enable, add these headers to your server:\n" +
          "  Cross-Origin-Embedder-Policy: require-corp\n" +
          "  Cross-Origin-Opener-Policy: same-origin"
      );
    }
  }

  async bundle(options: BundleOptions): Promise<BundleResult> {
    await this.initialize();

    if (!this.esbuild) {
      throw new Error("esbuild not initialized");
    }

    const {
      fs,
      entryPoint,
      installedPackages = {},
      sharedModules = [],
      sharedModuleRegistry,
      external = [],
      format = "esm",
      minify = false,
      sourcemap = false,
      target = ["es2020"],
    } = options;

    // Normalize entry point to absolute path
    const normalizedEntry = entryPoint.startsWith("/")
      ? entryPoint
      : `/${entryPoint}`;

    // Verify entry point exists
    if (!(await fs.exists(normalizedEntry))) {
      throw new Error(`Entry point not found: ${normalizedEntry}`);
    }

    // Track files included in the bundle
    const includedFiles = new Set<string>();

    // Create the VFS plugin
    const plugin = createVfsPlugin({
      fs,
      entryPoint: normalizedEntry,
      installedPackages,
      sharedModules: new Set(sharedModules),
      sharedModuleRegistry: sharedModuleRegistry ?? null,
      cdnBaseUrl: this.options.cdnBaseUrl!,
      includedFiles,
    });

    // Run esbuild
    const result = await this.esbuild.build({
      entryPoints: [normalizedEntry],
      bundle: true,
      write: false,
      format,
      minify,
      sourcemap: sourcemap ? "inline" : false,
      target,
      external,
      plugins: [plugin],
      jsx: "automatic",
    });

    const code = result.outputFiles?.[0]?.text ?? "";

    // Convert esbuild warnings to our format
    const warnings: BundleWarning[] = result.warnings.map((w) => ({
      text: w.text,
      location: w.location
        ? {
            file: w.location.file,
            line: w.location.line,
            column: w.location.column,
          }
        : undefined,
    }));

    return {
      code,
      warnings,
      includedFiles: Array.from(includedFiles),
    };
  }
}

// =============================================================================
// VFS Plugin
// =============================================================================

interface VfsPluginOptions {
  fs: IFileSystem;
  entryPoint: string;
  installedPackages: Record<string, string>;
  sharedModules: Set<string>;
  sharedModuleRegistry: ISharedModuleRegistry | null;
  cdnBaseUrl: string;
  includedFiles: Set<string>;
}

/**
 * Get the registry key for shared module access.
 * Returns null if no registry is provided.
 */
function getRegistryKey(registry: ISharedModuleRegistry | null): string | null {
  return registry?.registryKey ?? null;
}

/**
 * Create an esbuild plugin that reads from a virtual filesystem.
 */
function createVfsPlugin(options: VfsPluginOptions): EsbuildTypes.Plugin {
  const {
    fs,
    entryPoint,
    installedPackages,
    sharedModules,
    sharedModuleRegistry,
    cdnBaseUrl,
    includedFiles,
  } = options;

  return {
    name: "sandlot-vfs",
    setup(build) {
      // ---------------------------------------------------------------------
      // Resolution
      // ---------------------------------------------------------------------

      build.onResolve({ filter: /.*/ }, async (args) => {
        // Entry point → VFS namespace
        if (args.kind === "entry-point") {
          return { path: entryPoint, namespace: "vfs" };
        }

        // Bare imports (not starting with . or /)
        if (isBareImport(args.path)) {
          // Check if this is a shared module
          const sharedMatch = matchSharedModule(args.path, sharedModules);
          if (sharedMatch) {
            return { path: sharedMatch, namespace: "sandlot-shared" };
          }

          // Rewrite to CDN URL if package is installed
          const cdnUrl = resolveToEsmUrl(args.path, installedPackages, cdnBaseUrl);
          if (cdnUrl) {
            return { path: cdnUrl, external: true };
          }

          // Not installed - mark as external (will fail at runtime if not available)
          return { path: args.path, external: true };
        }

        // Relative or absolute imports → resolve in VFS
        const resolved = await resolveVfsPath(fs, args.resolveDir, args.path);
        if (resolved) {
          return { path: resolved, namespace: "vfs" };
        }

        return {
          errors: [{ text: `Cannot resolve: ${args.path} from ${args.resolveDir}` }],
        };
      });

      // ---------------------------------------------------------------------
      // Loading: VFS files
      // ---------------------------------------------------------------------

      build.onLoad({ filter: /.*/, namespace: "vfs" }, async (args) => {
        try {
          const contents = await fs.readFile(args.path);
          includedFiles.add(args.path);

          return {
            contents,
            loader: getLoader(args.path),
            resolveDir: dirname(args.path),
          };
        } catch (err) {
          return {
            errors: [{ text: `Failed to read ${args.path}: ${err}` }],
          };
        }
      });

      // ---------------------------------------------------------------------
      // Loading: Shared modules
      // ---------------------------------------------------------------------

      build.onLoad({ filter: /.*/, namespace: "sandlot-shared" }, (args) => {
        const moduleId = args.path;

        // Generate code that accesses the shared module registry at runtime
        const runtimeCode = generateSharedModuleCode(
          moduleId,
          sharedModuleRegistry
        );

        return {
          contents: runtimeCode,
          loader: "js",
        };
      });
    },
  };
}

// =============================================================================
// Resolution Helpers
// =============================================================================

/**
 * Check if a path is a bare import (npm package, not relative/absolute)
 */
function isBareImport(path: string): boolean {
  return !path.startsWith(".") && !path.startsWith("/");
}

/**
 * Check if an import matches a shared module.
 * Handles exact matches and subpath imports.
 */
function matchSharedModule(
  importPath: string,
  sharedModules: Set<string>
): string | null {
  // Exact match
  if (sharedModules.has(importPath)) {
    return importPath;
  }

  // Check if any shared module is a prefix (for subpath imports)
  for (const moduleId of sharedModules) {
    if (importPath.startsWith(moduleId + "/")) {
      // The full import path should be registered
      // e.g., if "react-dom/client" is shared, match it exactly
      // This allows partial sharing where only specific subpaths are shared
      if (sharedModules.has(importPath)) {
        return importPath;
      }
    }
  }

  return null;
}

/**
 * Parse an import path into package name and subpath.
 */
function parseImportPath(importPath: string): {
  packageName: string;
  subpath?: string;
} {
  // Scoped packages: @scope/name or @scope/name/subpath
  if (importPath.startsWith("@")) {
    const parts = importPath.split("/");
    if (parts.length >= 2) {
      const packageName = `${parts[0]}/${parts[1]}`;
      const subpath = parts.length > 2 ? parts.slice(2).join("/") : undefined;
      return { packageName, subpath };
    }
    return { packageName: importPath };
  }

  // Regular packages: name or name/subpath
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
 * Resolve a bare import to an esm.sh CDN URL.
 */
function resolveToEsmUrl(
  importPath: string,
  installedPackages: Record<string, string>,
  cdnBaseUrl: string
): string | null {
  const { packageName, subpath } = parseImportPath(importPath);

  const version = installedPackages[packageName];
  if (!version) {
    return null;
  }

  const baseUrl = `${cdnBaseUrl}/${packageName}@${version}`;
  return subpath ? `${baseUrl}/${subpath}` : baseUrl;
}

/**
 * Resolve a relative or absolute path in the VFS.
 * Tries extensions and index files as needed.
 */
async function resolveVfsPath(
  fs: IFileSystem,
  resolveDir: string,
  importPath: string
): Promise<string | null> {
  // Resolve the path relative to resolveDir
  const resolved = resolvePath(resolveDir, importPath);

  // Extensions to try
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"];

  // Check if path already has an extension we recognize
  const hasExtension = extensions.some((ext) => resolved.endsWith(ext));

  if (hasExtension) {
    if (await fs.exists(resolved)) {
      return resolved;
    }
    return null;
  }

  // Try adding extensions
  for (const ext of extensions) {
    const withExt = resolved + ext;
    if (await fs.exists(withExt)) {
      return withExt;
    }
  }

  // Try index files (for directory imports)
  for (const ext of extensions) {
    const indexPath = `${resolved}/index${ext}`;
    if (await fs.exists(indexPath)) {
      return indexPath;
    }
  }

  return null;
}

/**
 * Simple path resolution (handles . and ..)
 */
function resolvePath(from: string, to: string): string {
  if (to.startsWith("/")) {
    return normalizePath(to);
  }

  const fromParts = from.split("/").filter(Boolean);
  const toParts = to.split("/");

  // Start from the 'from' directory
  const result = [...fromParts];

  for (const part of toParts) {
    if (part === "." || part === "") {
      continue;
    } else if (part === "..") {
      result.pop();
    } else {
      result.push(part);
    }
  }

  return "/" + result.join("/");
}

/**
 * Normalize a path (remove . and ..)
 */
function normalizePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const result: string[] = [];

  for (const part of parts) {
    if (part === ".") {
      continue;
    } else if (part === "..") {
      result.pop();
    } else {
      result.push(part);
    }
  }

  return "/" + result.join("/");
}

/**
 * Get the directory name of a path
 */
function dirname(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return path.slice(0, lastSlash);
}

/**
 * Get the appropriate esbuild loader based on file extension
 */
function getLoader(path: string): EsbuildTypes.Loader {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
      return "ts";
    case "tsx":
      return "tsx";
    case "jsx":
      return "jsx";
    case "js":
    case "mjs":
      return "js";
    case "json":
      return "json";
    case "css":
      return "css";
    case "txt":
      return "text";
    default:
      return "js";
  }
}

// =============================================================================
// Shared Module Code Generation
// =============================================================================

/**
 * Generate JavaScript code that accesses a shared module at runtime.
 */
function generateSharedModuleCode(
  moduleId: string,
  registry: ISharedModuleRegistry | null
): string {
  const registryKey = getRegistryKey(registry);
  
  if (!registryKey) {
    // This shouldn't happen if the bundler is configured correctly,
    // but provide a clear error if it does
    return `throw new Error("Shared module '${moduleId}' requested but no registry configured");`;
  }

  // Generate the runtime access code using the instance-specific registry key
  const runtimeAccess = `
(function() {
  var registry = globalThis["${registryKey}"];
  if (!registry) {
    throw new Error(
      'Sandlot SharedModuleRegistry not found at "${registryKey}". ' +
      'Ensure sharedModules are configured in createSandlot() options.'
    );
  }
  return registry.get(${JSON.stringify(moduleId)});
})()
`.trim();

  // Get export names if registry is available (for generating named exports)
  const exportNames = registry?.getExportNames(moduleId) ?? [];

  // Build the module code
  let code = `const __sandlot_mod__ = ${runtimeAccess};\n`;

  // Default export (handle both { default: x } and direct export)
  code += `export default __sandlot_mod__.default ?? __sandlot_mod__;\n`;

  // Named exports
  if (exportNames.length > 0) {
    for (const name of exportNames) {
      code += `export const ${name} = __sandlot_mod__.${name};\n`;
    }
  } else {
    // No export info available - add a comment
    code += `// No named exports discovered for "${moduleId}"\n`;
    code += `// Use: import mod from "${moduleId}"; mod.exportName\n`;
  }

  return code;
}
