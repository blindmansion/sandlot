/**
 * Shared bundler utilities used by both browser and node bundlers.
 *
 * This module contains the VFS plugin, path resolution, and shared module
 * code generation logic that is common to both esbuild and esbuild-wasm.
 */

import type {
  ISharedModuleRegistry,
  BundleOptions,
  BundleResult,
  BundleWarning,
  BundleError,
  BundleLocation,
  Filesystem,
} from "../types";

// =============================================================================
// Types
// =============================================================================

/**
 * Minimal esbuild types needed for the shared utilities.
 * These are compatible with both esbuild and esbuild-wasm.
 */
export interface EsbuildMessage {
  text: string;
  location?: {
    file: string;
    line: number;
    column: number;
    lineText: string;
  } | null;
}

export interface EsbuildPlugin {
  name: string;
  setup: (build: EsbuildPluginBuild) => void;
}

export interface EsbuildPluginBuild {
  onResolve: (
    options: { filter: RegExp; namespace?: string },
    callback: (args: EsbuildResolveArgs) => Promise<EsbuildResolveResult | null | undefined> | EsbuildResolveResult | null | undefined
  ) => void;
  onLoad: (
    options: { filter: RegExp; namespace?: string },
    callback: (args: EsbuildLoadArgs) => Promise<EsbuildLoadResult | null | undefined> | EsbuildLoadResult | null | undefined
  ) => void;
}

export interface EsbuildResolveArgs {
  path: string;
  kind: string;
  resolveDir: string;
  importer: string;
  namespace: string;
}

export interface EsbuildResolveResult {
  path?: string;
  namespace?: string;
  external?: boolean;
  errors?: Array<{ text: string }>;
}

export interface EsbuildLoadArgs {
  path: string;
}

export interface EsbuildLoadResult {
  contents?: string;
  loader?: string;
  resolveDir?: string;
  errors?: Array<{ text: string }>;
}

export type EsbuildLoader =
  | "js"
  | "jsx"
  | "ts"
  | "tsx"
  | "json"
  | "css"
  | "text";

// =============================================================================
// Error Handling Helpers
// =============================================================================

/**
 * Type guard for esbuild BuildFailure
 */
export function isEsbuildBuildFailure(
  err: unknown
): err is { errors: EsbuildMessage[]; warnings: EsbuildMessage[] } {
  return (
    typeof err === "object" &&
    err !== null &&
    "errors" in err &&
    Array.isArray((err as { errors: unknown }).errors)
  );
}

/**
 * Convert esbuild Message to our BundleError/BundleWarning format
 */
export function convertEsbuildMessage(
  msg: EsbuildMessage
): BundleError | BundleWarning {
  let location: BundleLocation | undefined;

  if (msg.location) {
    location = {
      file: msg.location.file,
      line: msg.location.line,
      column: msg.location.column,
      lineText: msg.location.lineText,
    };
  }

  return {
    text: msg.text,
    location,
  };
}

// =============================================================================
// VFS Plugin
// =============================================================================

export interface VfsPluginOptions {
  fs: Filesystem;
  entryPoint: string;
  installedPackages: Record<string, string>;
  sharedModules: Set<string>;
  sharedModuleRegistry: ISharedModuleRegistry | null;
  cdnBaseUrl: string;
  includedFiles: Set<string>;
  /**
   * If true, CDN imports (http/https URLs) will be bundled by esbuild
   * rather than marked as external. This is required for Node/Bun
   * since they cannot resolve HTTP imports at runtime.
   * 
   * - Browser: false (external) - browser can fetch at runtime
   * - Node/Bun: true (bundle) - native esbuild fetches during build
   * 
   * @default false
   */
  bundleCdnImports?: boolean;
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
export function createVfsPlugin(options: VfsPluginOptions): EsbuildPlugin {
  const {
    fs,
    entryPoint,
    installedPackages,
    sharedModules,
    sharedModuleRegistry,
    cdnBaseUrl,
    includedFiles,
    bundleCdnImports = false,
  } = options;

  return {
    name: "sandlot-vfs",
    setup(build) {
      // ---------------------------------------------------------------------
      // Resolution
      // ---------------------------------------------------------------------

      build.onResolve({ filter: /.*/ }, async (args) => {
        // Skip if this is a resolution from the http namespace
        // (those are handled by the http-specific onResolve handler)
        if (args.namespace === "http") {
          return undefined;
        }
        
        // Entry point → VFS namespace
        if (args.kind === "entry-point") {
          return { path: entryPoint, namespace: "vfs" };
        }

        // HTTP/HTTPS URLs handling
        // - Browser: mark as external (browser fetches at runtime)
        // - Node/Bun: use http namespace to fetch and bundle
        if (args.path.startsWith("http://") || args.path.startsWith("https://")) {
          if (bundleCdnImports) {
            // Put in http namespace so our onLoad handler can fetch it
            return { path: args.path, namespace: "http" };
          }
          return { path: args.path, external: true };
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
            if (bundleCdnImports) {
              // Use http namespace so our onLoad handler can fetch it
              return { path: cdnUrl, namespace: "http" };
            }
            return { path: cdnUrl, external: true };
          }

          // Not installed - mark as external (will fail at runtime if not available)
          return { path: args.path, external: true };
        }

        // Relative or absolute imports → resolve in VFS
        const resolved = resolveVfsPath(fs, args.resolveDir, args.path);
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
          const contents = fs.readFile(args.path);
          includedFiles.add(args.path);

          // Special handling for CSS: transform into JS that injects styles
          if (args.path.endsWith(".css")) {
            const cssInjectionCode = generateCssInjectionCode(contents);
            return {
              contents: cssInjectionCode,
              loader: "js",
              resolveDir: dirname(args.path),
            };
          }

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

      // ---------------------------------------------------------------------
      // Loading & Resolution: HTTP/HTTPS URLs (for Node/Bun bundling)
      // ---------------------------------------------------------------------

      if (bundleCdnImports) {
        // Resolve imports from within HTTP modules
        // The importer will be the full HTTP URL
        build.onResolve({ filter: /.*/, namespace: "http" }, (args) => {
          const importerUrl = args.importer; // e.g., https://esm.sh/nanoid@latest
          
          // Node.js built-in modules should be external (resolved at runtime)
          if (args.path.startsWith("node:")) {
            return { path: args.path, external: true };
          }
          
          if (args.path.startsWith("http://") || args.path.startsWith("https://")) {
            // Already a full URL
            return { path: args.path, namespace: "http" };
          }
          
          if (args.path.startsWith("/")) {
            // Absolute path - resolve against the origin
            const origin = new URL(importerUrl).origin;
            return { path: origin + args.path, namespace: "http" };
          }
          
          if (args.path.startsWith(".")) {
            // Relative path - resolve against the importer's directory
            const resolved = new URL(args.path, importerUrl).href;
            return { path: resolved, namespace: "http" };
          }
          
          // Bare import from within an HTTP module - check if it's a known package
          // This handles cases where a CDN module imports another package
          const cdnUrl = resolveToEsmUrl(args.path, installedPackages, cdnBaseUrl);
          if (cdnUrl) {
            return { path: cdnUrl, namespace: "http" };
          }
          
          // Unknown bare import - try to resolve from the CDN with latest version
          // (esm.sh and similar CDNs can resolve packages automatically)
          const fallbackUrl = `${cdnBaseUrl}/${args.path}`;
          return { path: fallbackUrl, namespace: "http" };
        });

        // Load HTTP modules by fetching them
        build.onLoad({ filter: /.*/, namespace: "http" }, async (args) => {
          try {
            const response = await fetch(args.path);
            if (!response.ok) {
              return {
                errors: [{ text: `Failed to fetch ${args.path}: ${response.status} ${response.statusText}` }],
              };
            }

            const contents = await response.text();
            
            // Determine loader from URL
            const loader = getLoaderFromUrl(args.path);

            return {
              contents,
              loader,
              // Don't set resolveDir - we'll handle resolution via namespace
            };
          } catch (err) {
            return {
              errors: [{ text: `Failed to fetch ${args.path}: ${err}` }],
            };
          }
        });
      }
    },
  };
}

/**
 * Get the appropriate loader based on URL path
 */
function getLoaderFromUrl(url: string): EsbuildLoader {
  try {
    const pathname = new URL(url).pathname;
    return getLoader(pathname);
  } catch {
    return "js";
  }
}

// =============================================================================
// Resolution Helpers
// =============================================================================

/**
 * Check if a path is a bare import (npm package, not relative/absolute)
 */
export function isBareImport(path: string): boolean {
  return !path.startsWith(".") && !path.startsWith("/");
}

/**
 * Check if an import matches a shared module.
 * Handles exact matches and subpath imports.
 */
export function matchSharedModule(
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
export function parseImportPath(importPath: string): {
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
export function resolveToEsmUrl(
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
export function resolveVfsPath(
  fs: Filesystem,
  resolveDir: string,
  importPath: string
): string | null {
  // Resolve the path relative to resolveDir
  const resolved = resolvePath(resolveDir, importPath);

  // Extensions to try
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json", ".css"];

  // Check if path already has an extension we recognize
  const hasExtension = extensions.some((ext) => resolved.endsWith(ext));

  if (hasExtension) {
    if (fs.exists(resolved)) {
      return resolved;
    }
    return null;
  }

  // Try adding extensions
  for (const ext of extensions) {
    const withExt = resolved + ext;
    if (fs.exists(withExt)) {
      return withExt;
    }
  }

  // Try index files (for directory imports)
  for (const ext of extensions) {
    const indexPath = `${resolved}/index${ext}`;
    if (fs.exists(indexPath)) {
      return indexPath;
    }
  }

  return null;
}

/**
 * Simple path resolution (handles . and ..)
 */
export function resolvePath(from: string, to: string): string {
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
export function normalizePath(path: string): string {
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
export function dirname(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return path.slice(0, lastSlash);
}

/**
 * Get the appropriate esbuild loader based on file extension
 */
export function getLoader(path: string): EsbuildLoader {
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
// CSS Injection Code Generation
// =============================================================================

/**
 * Generate JavaScript code that injects CSS into the document.
 * This transforms CSS imports into runtime style injection.
 */
export function generateCssInjectionCode(css: string): string {
  // Escape the CSS for embedding in a JS string
  const escapedCss = JSON.stringify(css);
  
  return `
(function() {
  if (typeof document !== 'undefined') {
    var style = document.createElement('style');
    style.type = 'text/css';
    style.textContent = ${escapedCss};
    document.head.appendChild(style);
  }
})();
`.trim();
}

// =============================================================================
// Shared Module Code Generation
// =============================================================================

/**
 * Generate JavaScript code that accesses a shared module at runtime.
 */
export function generateSharedModuleCode(
  moduleId: string,
  registry: ISharedModuleRegistry | null
): string {
  const registryKey = getRegistryKey(registry);

  if (!registryKey) {
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
    code += `// No named exports discovered for "${moduleId}"\n`;
    code += `// Use: import mod from "${moduleId}"; mod.exportName\n`;
  }

  return code;
}

// =============================================================================
// Shared Bundle Execution
// =============================================================================

/**
 * Minimal esbuild interface needed for bundling.
 * Compatible with both esbuild and esbuild-wasm.
 *
 * Uses a loose `Record<string, unknown>` for build options to avoid
 * type conflicts between the various esbuild module signatures.
 */
export interface EsbuildInstance {
  build(options: Record<string, unknown>): Promise<{
    outputFiles?: Array<{ text: string }>;
    warnings: EsbuildMessage[];
  }>;
}

/**
 * Options for the shared bundle execution helper.
 */
export interface ExecuteBundleOptions {
  /** The esbuild instance to use */
  esbuild: EsbuildInstance;
  /** Bundle options from the IBundler interface */
  bundleOptions: BundleOptions;
  /** Base URL for CDN imports */
  cdnBaseUrl: string;
  /**
   * Whether to bundle CDN imports inline.
   * - Browser: false (external) - browser can fetch at runtime
   * - Node/Bun: true (bundle) - esbuild fetches during build
   */
  bundleCdnImports: boolean;
}

/**
 * Execute a bundle using esbuild with the VFS plugin.
 *
 * This is the shared implementation used by both browser and node WASM bundlers.
 * It handles entry point normalization, VFS plugin creation, and error handling.
 *
 * @param options - Bundle execution options
 * @returns Bundle result with code or errors
 */
export async function executeBundleWithEsbuild(
  options: ExecuteBundleOptions
): Promise<BundleResult> {
  const { esbuild, bundleOptions, cdnBaseUrl, bundleCdnImports } = options;

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
  } = bundleOptions;

  // Normalize entry point to absolute path
  const normalizedEntry = entryPoint.startsWith("/")
    ? entryPoint
    : `/${entryPoint}`;

  // Verify entry point exists
  if (!fs.exists(normalizedEntry)) {
    return {
      success: false,
      errors: [{ text: `Entry point not found: ${normalizedEntry}` }],
      warnings: [],
    };
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
    cdnBaseUrl,
    includedFiles,
    bundleCdnImports,
  });

  try {
    // Run esbuild
    const result = await esbuild.build({
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
    const warnings: BundleWarning[] = result.warnings.map((w) =>
      convertEsbuildMessage(w)
    );

    return {
      success: true,
      code,
      warnings,
      includedFiles: Array.from(includedFiles),
    };
  } catch (err) {
    // esbuild throws BuildFailure with .errors array
    if (isEsbuildBuildFailure(err)) {
      const errors: BundleError[] = err.errors.map((e) =>
        convertEsbuildMessage(e)
      );
      const warnings: BundleWarning[] = err.warnings.map((w) =>
        convertEsbuildMessage(w)
      );
      return {
        success: false,
        errors,
        warnings,
      };
    }

    // Unknown error - wrap it
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errors: [{ text: message }],
      warnings: [],
    };
  }
}
