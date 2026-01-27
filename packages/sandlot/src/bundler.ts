import type { IFileSystem } from "just-bash/browser";
import type * as EsbuildTypes from "esbuild-wasm";
import { getPackageManifest, resolveToEsmUrl } from "./packages";
import { getSharedModuleRuntimeCode, getSharedModuleExports } from "./shared-modules";

// Lazily loaded esbuild module - loaded from CDN to avoid bundler issues
let esbuild: typeof EsbuildTypes | null = null;

async function getEsbuild(): Promise<typeof EsbuildTypes> {
  if (esbuild) return esbuild;

  // Load esbuild-wasm from esm.sh CDN to avoid bundler transformation issues
  // esm.sh provides proper ESM wrappers for npm packages
  const cdnUrl = `https://esm.sh/esbuild-wasm@${ESBUILD_VERSION}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(/* @vite-ignore */ cdnUrl);

  // esm.sh typically provides both default and named exports
  esbuild = mod.default ?? mod;

  // Verify we have the initialize function
  if (typeof esbuild?.initialize !== 'function') {
    console.error('esbuild-wasm module structure:', mod);
    throw new Error('Failed to load esbuild-wasm: initialize function not found');
  }

  return esbuild;
}

/**
 * How to handle npm package imports (bare imports like "react").
 * 
 * - "cdn" (default): Rewrite to esm.sh CDN URLs using installed package versions.
 *   Requires packages to be installed via the `install` command.
 * - "external": Mark as external, don't rewrite. The consumer must handle
 *   module resolution (useful for SSR or custom bundling).
 * - "bundle": Attempt to bundle from node_modules. Rarely useful in browser
 *   since node_modules typically doesn't exist in the virtual filesystem.
 */
export type NpmImportsMode = "cdn" | "external" | "bundle";

/**
 * Options for bundling
 */
export interface BundleOptions {
  /**
   * The virtual filesystem to read source files from
   */
  fs: IFileSystem;

  /**
   * Entry point path (absolute path in the virtual filesystem)
   */
  entryPoint: string;

  /**
   * Module names to mark as external (won't be bundled).
   * These are in addition to bare imports when using npmImports: "external".
   */
  external?: string[];

  /**
   * How to handle npm package imports (bare imports like "react").
   * 
   * - "cdn" (default): Rewrite to esm.sh CDN URLs using installed package versions
   * - "external": Mark as external, don't rewrite (consumer must handle)
   * - "bundle": Attempt to bundle from node_modules (rarely useful in browser)
   */
  npmImports?: NpmImportsMode;

  /**
   * Module IDs that should be resolved from the host's SharedModuleRegistry
   * instead of esm.sh CDN. The host must have registered these modules.
   * 
   * Example: ['react', 'react-dom/client']
   * 
   * When specified, imports of these modules will use the host's instances,
   * allowing dynamic components to share React context, hooks, etc.
   */
  sharedModules?: string[];

  /**
   * Output format: 'esm' (default), 'iife', or 'cjs'
   */
  format?: "esm" | "iife" | "cjs";

  /**
   * Enable minification
   * Default: false
   */
  minify?: boolean;

  /**
   * Enable source maps (inline)
   * Default: false
   */
  sourcemap?: boolean;

  /**
   * Global name for IIFE format
   */
  globalName?: string;

  /**
   * Target environment(s)
   * Default: ['es2020']
   */
  target?: string[];
}

/**
 * Result of bundling
 */
export interface BundleResult {
  /**
   * The bundled JavaScript code
   */
  code: string;

  /**
   * Any warnings from esbuild
   */
  warnings: EsbuildTypes.Message[];

  /**
   * List of files that were included in the bundle
   */
  includedFiles: string[];
}

/**
 * esbuild-wasm version - MUST match the version in package.json dependencies
 */
const ESBUILD_VERSION = "0.27.2";

// Track initialization state
let initialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Get the esbuild-wasm binary URL based on the installed version
 */
function getWasmUrl(): string {
  return `https://unpkg.com/esbuild-wasm@${ESBUILD_VERSION}/esbuild.wasm`;
}

/**
 * Check if the browser environment supports cross-origin isolation.
 * This is needed for SharedArrayBuffer which esbuild-wasm may use.
 */
function checkCrossOriginIsolation(): void {
  if (typeof window === "undefined") return; // Not in browser

  // crossOriginIsolated is true when COOP/COEP headers are set correctly
  if (!window.crossOriginIsolated) {
    console.warn(
      "[sandlot] Cross-origin isolation is not enabled. " +
      "esbuild-wasm may have reduced performance or fail on some browsers.\n" +
      "To enable, add these headers to your dev server:\n" +
      "  Cross-Origin-Embedder-Policy: require-corp\n" +
      "  Cross-Origin-Opener-Policy: same-origin\n" +
      "In Vite, add a plugin to configureServer. See sandlot README for details."
    );
  }
}

/**
 * Initialize esbuild-wasm. Called automatically on first bundle.
 * Can be called explicitly to pre-warm.
 */
export async function initBundler(): Promise<void> {
  if (initialized) return;

  if (initPromise) {
    await initPromise;
    return;
  }

  checkCrossOriginIsolation();

  initPromise = (async () => {
    const es = await getEsbuild();
    await es.initialize({
      wasmURL: getWasmUrl(),
    });
  })();

  await initPromise;
  initialized = true;
}

/**
 * Check if a path is a bare import (not relative or absolute)
 */
function isBareImport(path: string): boolean {
  return !path.startsWith(".") && !path.startsWith("/");
}

/**
 * Get the appropriate loader based on file extension
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

/**
 * Options for the VFS plugin
 */
interface VfsPluginOptions {
  fs: IFileSystem;
  entryPoint: string;
  npmImports: NpmImportsMode;
  installedPackages: Record<string, string>;
  includedFiles: Set<string>;
  /** Module IDs to resolve from SharedModuleRegistry */
  sharedModuleIds: Set<string>;
}

/**
 * Check if an import path matches a shared module ID.
 * Handles both exact matches and subpath imports (e.g., 'react-dom/client').
 */
function matchesSharedModule(importPath: string, sharedModuleIds: Set<string>): string | null {
  // Check exact match first
  if (sharedModuleIds.has(importPath)) {
    return importPath;
  }

  // Check if any shared module is a prefix (for subpath imports)
  // e.g., if 'react-dom' is registered, 'react-dom/client' should match
  for (const moduleId of sharedModuleIds) {
    if (importPath === moduleId || importPath.startsWith(moduleId + '/')) {
      return importPath;
    }
  }

  return null;
}

/**
 * Create an esbuild plugin that reads from a virtual filesystem
 */
function createVfsPlugin(options: VfsPluginOptions): EsbuildTypes.Plugin {
  const {
    fs,
    entryPoint,
    npmImports,
    installedPackages,
    includedFiles,
    sharedModuleIds,
  } = options;

  return {
    name: "virtual-fs",
    setup(build) {
      // Resolve all imports
      build.onResolve({ filter: /.*/ }, async (args) => {
        // Handle the virtual entry point
        if (args.kind === "entry-point") {
          return { path: entryPoint, namespace: "vfs" };
        }

        // Handle bare imports
        if (isBareImport(args.path)) {
          // Check if this module should use the shared registry
          const sharedMatch = matchesSharedModule(args.path, sharedModuleIds);
          if (sharedMatch) {
            return {
              path: sharedMatch,
              namespace: "sandlot-shared"
            };
          }

          // Handle based on npmImports mode
          switch (npmImports) {
            case "cdn": {
              // Try to rewrite to esm.sh URL if package is installed
              const esmUrl = resolveToEsmUrl(args.path, installedPackages);
              if (esmUrl) {
                return { path: esmUrl, external: true };
              }
              // Fall back to external if not installed
              return { path: args.path, external: true };
            }

            case "external":
              // Mark as external, don't rewrite
              return { path: args.path, external: true };

            case "bundle": {
              // Try to resolve from VFS node_modules
              const resolved = fs.resolvePath(args.resolveDir, `node_modules/${args.path}`);
              const exists = await fs.exists(resolved);
              if (exists) {
                return { path: resolved, namespace: "vfs" };
              }
              // Fall back to external if not found
              return { path: args.path, external: true };
            }
          }
        }

        // Resolve relative/absolute paths
        const resolved = fs.resolvePath(args.resolveDir, args.path);

        // Try with extensions if no extension provided
        const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"];
        const hasExtension = extensions.some((ext) => resolved.endsWith(ext));

        if (hasExtension) {
          const exists = await fs.exists(resolved);
          if (exists) {
            return { path: resolved, namespace: "vfs" };
          }
          return { errors: [{ text: `File not found: ${resolved}` }] };
        }

        // Try adding extensions
        for (const ext of extensions) {
          const withExt = resolved + ext;
          if (await fs.exists(withExt)) {
            return { path: withExt, namespace: "vfs" };
          }
        }

        // Try index files
        for (const ext of extensions) {
          const indexPath = `${resolved}/index${ext}`;
          if (await fs.exists(indexPath)) {
            return { path: indexPath, namespace: "vfs" };
          }
        }

        return { errors: [{ text: `Cannot resolve: ${args.path} from ${args.resolveDir}` }] };
      });

      // Load shared modules from the registry
      build.onLoad({ filter: /.*/, namespace: "sandlot-shared" }, (args) => {
        // Generate ESM code that re-exports from the shared module registry
        const contents = `
const __sandlot_mod__ = ${getSharedModuleRuntimeCode(args.path)};
export default __sandlot_mod__.default ?? __sandlot_mod__;
${generateNamedExports(args.path)}
`;
        return {
          contents: contents.trim(),
          loader: 'js'
        };
      });

      // Load files from VFS
      build.onLoad({ filter: /.*/, namespace: "vfs" }, async (args) => {
        try {
          const contents = await fs.readFile(args.path);
          includedFiles.add(args.path);
          return {
            contents,
            loader: getLoader(args.path),
            resolveDir: args.path.substring(0, args.path.lastIndexOf("/")),
          };
        } catch (err) {
          return {
            errors: [{ text: `Failed to read ${args.path}: ${err}` }],
          };
        }
      });
    },
  };
}

/**
 * Generate named export statements for shared modules.
 * 
 * Uses dynamically discovered exports from the SharedModuleRegistry,
 * which are populated when registerSharedModules() is called.
 * 
 * If the module wasn't registered (or has no enumerable exports),
 * returns a comment - named imports won't work but default import will.
 */
function generateNamedExports(moduleId: string): string {
  const exports = getSharedModuleExports(moduleId);

  if (exports.length > 0) {
    return exports
      .map(name => `export const ${name} = __sandlot_mod__.${name};`)
      .join('\n');
  }

  // Module not registered or has no enumerable exports
  // Default import will still work: import foo from 'module'
  return `// No exports discovered for "${moduleId}" - use default import or call registerSharedModules() first`;
}

/**
 * Bundle TypeScript/JavaScript files from a virtual filesystem
 *
 * @example
 * ```ts
 * const fs = Filesystem.create({
 *   initialFiles: {
 *     "/src/index.ts": "export const hello = 'world';",
 *     "/src/utils.ts": "export function add(a: number, b: number) { return a + b; }",
 *   }
 * });
 *
 * const result = await bundle({
 *   fs,
 *   entryPoint: "/src/index.ts",
 * });
 *
 * console.log(result.code);
 * ```
 */
export async function bundle(options: BundleOptions): Promise<BundleResult> {
  await initBundler();

  const {
    fs,
    entryPoint,
    external = [],
    npmImports = "cdn",
    sharedModules = [],
    format = "esm",
    minify = false,
    sourcemap = false,
    globalName,
    target = ["es2020"],
  } = options;

  // Normalize entry point
  const normalizedEntry = entryPoint.startsWith("/") ? entryPoint : `/${entryPoint}`;

  // Verify entry point exists
  if (!(await fs.exists(normalizedEntry))) {
    throw new Error(`Entry point not found: ${normalizedEntry}`);
  }

  // Get installed packages for ESM URL rewriting
  const manifest = await getPackageManifest(fs);
  const installedPackages = manifest.dependencies;

  // Create set of shared module IDs for fast lookup
  const sharedModuleIds = new Set(sharedModules);

  const includedFiles = new Set<string>();
  const plugin = createVfsPlugin({
    fs,
    entryPoint: normalizedEntry,
    npmImports,
    installedPackages,
    includedFiles,
    sharedModuleIds,
  });

  const es = await getEsbuild();
  const result = await es.build({
    entryPoints: [normalizedEntry],
    bundle: true,
    write: false,
    format,
    minify,
    sourcemap: sourcemap ? "inline" : false,
    globalName,
    target,
    external,
    plugins: [plugin],
    jsx: "automatic",
  });

  const code = result.outputFiles?.[0]?.text ?? "";

  return {
    code,
    warnings: result.warnings,
    includedFiles: Array.from(includedFiles),
  };
}

/**
 * Bundle and return a blob URL for dynamic import
 *
 * @example
 * ```ts
 * const url = await bundleToUrl({
 *   fs,
 *   entryPoint: "/src/index.ts",
 * });
 *
 * const module = await import(url);
 * console.log(module.hello); // 'world'
 *
 * // Clean up when done
 * URL.revokeObjectURL(url);
 * ```
 */
export async function bundleToUrl(options: BundleOptions): Promise<string> {
  const result = await bundle(options);
  const blob = new Blob([result.code], { type: "application/javascript" });
  return URL.createObjectURL(blob);
}

/**
 * Bundle and immediately import the module
 *
 * @example
 * ```ts
 * const module = await bundleAndImport<{ hello: string }>({
 *   fs,
 *   entryPoint: "/src/index.ts",
 * });
 *
 * console.log(module.hello); // 'world'
 * ```
 */
export async function bundleAndImport<T = unknown>(options: BundleOptions): Promise<T> {
  const url = await bundleToUrl(options);
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
