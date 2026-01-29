/**
 * Sandbox implementation for v2.
 *
 * A sandbox is a single-project environment with its own:
 * - Virtual filesystem (sync)
 * - Installed packages (tracked in /package.json)
 * - Build configuration (entry point, tsconfig)
 *
 * The sandbox exposes both direct methods (install, build, etc.) and
 * shell commands via exec() for flexibility.
 *
 * Build produces a code string but does NOT load or execute it.
 * Execution is handled by an external executor (main thread, worker, iframe, etc.)
 * which provides appropriate isolation and security boundaries.
 */

import { Bash } from "just-bash/browser";
import type {
  IBundler,
  ITypechecker,
  ITypesResolver,
  ISharedModuleRegistry,
  IExecutor,
  Sandbox,
  SandboxOptions,
  SandboxState,
  SandboxBuildOptions,
  SandboxTypecheckOptions,
  BuildResult,
  BuildSuccess,
  InstallResult,
  UninstallResult,
  TypecheckResult,
  ExecResult,
  RunOptions,
  RunResult,
  TailwindOptions,
} from "../types";
import { Filesystem, wrapFilesystemForJustBash } from "./fs";
import { createDefaultCommands, type SandboxRef } from "../commands";
import { generateCssInjectionCode } from "./bundler-utils";
import type { ICache } from "./persistor";
import type { ResolvedTypes } from "./esm-types-resolver";

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_ENTRY_POINT = "./index.ts";
const TSCONFIG_PATH = "/tsconfig.json";
const PACKAGE_JSON_PATH = "/package.json";

const DEFAULT_PACKAGE_JSON = {
  main: DEFAULT_ENTRY_POINT,
  dependencies: {},
};

const DEFAULT_TSCONFIG = {
  compilerOptions: {
    target: "ES2020",
    lib: ["ES2020", "DOM", "DOM.Iterable"],
    module: "ESNext",
    moduleResolution: "bundler",
    jsx: "react-jsx",
    strict: true,
    noEmit: true,
    esModuleInterop: true,
    skipLibCheck: true,
    resolveJsonModule: true,
    isolatedModules: true,
  },
  include: ["**/*.ts", "**/*.tsx"],
  exclude: ["node_modules"],
};

// =============================================================================
// Tailwind CSS Processing
// =============================================================================

/**
 * Cached generateTailwindCSS function (loaded lazily)
 */
let tailwindGenerator: ((options: {
  content: string;
  css?: string;
  importCSS?: string;
}) => Promise<string>) | null = null;

/**
 * Load and cache the tailwindcss-iso generateTailwindCSS function.
 * Uses dynamic import to avoid loading WASM unless needed.
 */
async function getTailwindGenerator(): Promise<typeof tailwindGenerator> {
  if (tailwindGenerator) {
    return tailwindGenerator;
  }

  try {
    // Dynamic import - works in both browser and Node.js
    // tailwindcss-iso automatically selects the right implementation
    const tailwindModule = await import("tailwindcss-iso");
    tailwindGenerator = tailwindModule.generateTailwindCSS;
    return tailwindGenerator;
  } catch (err) {
    throw new Error(
      `Failed to load tailwindcss-iso: ${err instanceof Error ? err.message : String(err)}. ` +
      `Make sure tailwindcss-iso is installed.`
    );
  }
}

/**
 * Process Tailwind CSS for the given source files.
 * Returns JavaScript code that injects the generated CSS.
 */
async function processTailwind(
  fs: Filesystem,
  includedFiles: string[],
  options: TailwindOptions
): Promise<string> {
  const generator = await getTailwindGenerator();
  if (!generator) {
    throw new Error("Tailwind generator not available");
  }

  // Collect content from all included files
  const contentParts: string[] = [];
  for (const filePath of includedFiles) {
    try {
      const content = fs.readFileRaw(filePath);
      contentParts.push(content);
    } catch {
      // File might not exist or be readable, skip it
    }
  }

  const content = contentParts.join("\n");

  // Generate Tailwind CSS
  const tailwindCSS = await generator({
    content,
    css: options.css,
    importCSS: options.importCSS,
  });

  // Return JS code that injects the CSS
  return generateCssInjectionCode(tailwindCSS);
}

// =============================================================================
// Package Management Helpers (Sync)
// =============================================================================

/**
 * Parse package specifier into name and version
 */
function parsePackageSpec(spec: string): { name: string; version?: string } {
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
 * Read and parse /package.json
 */
function readPackageJson(
  fs: Filesystem
): { main?: string; dependencies?: Record<string, string> } {
  try {
    if (fs.exists(PACKAGE_JSON_PATH)) {
      const content = fs.readFileRaw(PACKAGE_JSON_PATH);
      return JSON.parse(content);
    }
  } catch {
    // Invalid JSON or read error
  }
  return {};
}

/**
 * Get the entry point from package.json's main field
 */
function getEntryPoint(fs: Filesystem): string {
  const pkg = readPackageJson(fs);
  const main = pkg.main ?? DEFAULT_ENTRY_POINT;
  // Normalize: ensure it starts with /
  if (main.startsWith("/")) {
    return main;
  }
  if (main.startsWith("./")) {
    return "/" + main.slice(2);
  }
  return "/" + main;
}

/**
 * Read installed packages from /package.json
 */
function getInstalledPackages(fs: Filesystem): Record<string, string> {
  const pkg = readPackageJson(fs);
  return pkg.dependencies ?? {};
}

/**
 * Parse tsconfig.json and extract path aliases.
 * 
 * Handles baseUrl and paths configuration:
 * - baseUrl defaults to "." (project root)
 * - paths like { "@/*": ["./src/*"] } are resolved relative to baseUrl
 * 
 * @returns Path aliases as a map of patterns to absolute VFS paths
 */
function getPathAliases(fs: Filesystem): Record<string, string[]> {
  try {
    if (!fs.exists(TSCONFIG_PATH)) {
      return {};
    }

    const content = fs.readFileRaw(TSCONFIG_PATH);
    const tsconfig = JSON.parse(content);
    const compilerOptions = tsconfig.compilerOptions ?? {};
    const paths = compilerOptions.paths;

    if (!paths || typeof paths !== "object") {
      return {};
    }

    // Get baseUrl, default to "." (root)
    const baseUrl = compilerOptions.baseUrl ?? ".";
    
    // Normalize baseUrl to absolute path
    const absoluteBaseUrl = baseUrl === "." ? "/" : 
      baseUrl.startsWith("/") ? baseUrl : "/" + baseUrl;

    // Convert paths to absolute paths
    const result: Record<string, string[]> = {};
    
    for (const [pattern, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets)) continue;
      
      result[pattern] = targets.map((target: string) => {
        // Remove leading ./ if present
        const normalized = target.startsWith("./") ? target.slice(2) : target;
        // Make absolute relative to baseUrl
        if (normalized.startsWith("/")) {
          return normalized;
        }
        return absoluteBaseUrl === "/" 
          ? "/" + normalized 
          : absoluteBaseUrl + "/" + normalized;
      });
    }

    return result;
  } catch {
    return {};
  }
}

/**
 * Save installed packages to /package.json
 */
function saveInstalledPackages(
  fs: Filesystem,
  dependencies: Record<string, string>
): void {
  let existing: Record<string, unknown> = {};

  try {
    if (fs.exists(PACKAGE_JSON_PATH)) {
      const content = fs.readFileRaw(PACKAGE_JSON_PATH);
      existing = JSON.parse(content);
    }
  } catch {
    // Start fresh if invalid
  }

  const updated = {
    ...existing,
    dependencies,
  };

  fs.writeFile(PACKAGE_JSON_PATH, JSON.stringify(updated, null, 2));
}

/**
 * Ensure a directory exists
 */
function ensureDir(fs: Filesystem, path: string): void {
  if (path === "/" || path === "") return;

  if (fs.exists(path)) {
    const stat = fs.stat(path);
    if (stat.isDirectory) return;
  }

  const parent = path.substring(0, path.lastIndexOf("/")) || "/";
  ensureDir(fs, parent);
  fs.mkdir(path);
}

/**
 * Delete a directory and all its contents
 */
function deleteDir(fs: Filesystem, path: string): void {
  if (!fs.exists(path)) return;
  fs.rm(path, { recursive: true, force: true });
}

/**
 * Write package types to the VFS.
 * Creates the package directory, writes all type files, and creates package.json.
 */
function writePackageTypes(
  fs: Filesystem,
  packageName: string,
  resolved: ResolvedTypes
): void {
  const packageDir = `/node_modules/${packageName}`;
  ensureDir(fs, packageDir);

  // Determine the main types entry file
  let typesEntry = "index.d.ts";
  let fallbackEntry: string | null = null;

  for (const [relativePath, content] of Object.entries(resolved.files)) {
    const fullPath = `${packageDir}/${relativePath}`;
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    ensureDir(fs, dir);
    fs.writeFile(fullPath, content);

    // Track types entry: prefer index.d.ts, fallback to first top-level .d.ts
    if (relativePath === "index.d.ts") {
      typesEntry = "index.d.ts";
    } else if (!fallbackEntry && relativePath.endsWith(".d.ts") && !relativePath.includes("/")) {
      fallbackEntry = relativePath;
    }
  }

  // Use index.d.ts if found, otherwise use fallback
  const finalTypesEntry = typesEntry ?? fallbackEntry ?? "index.d.ts";

  // Create package.json for TypeScript module resolution
  const pkgJsonPath = `${packageDir}/package.json`;
  const pkgJson = {
    name: packageName,
    version: resolved.version,
    types: finalTypesEntry,
    main: finalTypesEntry.replace(/\.d\.ts$/, ".js"),
  };
  fs.writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2));
}

/**
 * Ensure all package types are installed in /node_modules.
 * 
 * This function:
 * 1. Reads dependencies from /package.json
 * 2. Clears /node_modules
 * 3. For each dependency:
 *    - Checks the cache first
 *    - If not cached, fetches via resolver and caches
 *    - Writes type files to /node_modules/{pkg}/
 * 4. For shared modules with subpaths (e.g., react/jsx-runtime):
 *    - Also fetches types for the subpath and merges into package types
 * 
 * Called by typecheck() before type checking.
 */
async function ensureTypesInstalled(
  fs: Filesystem,
  typesResolver: ITypesResolver | undefined,
  cache: ICache<ResolvedTypes> | undefined,
  sharedModuleRegistry: ISharedModuleRegistry | null
): Promise<void> {
  const dependencies = getInstalledPackages(fs);
  const packageNames = Object.keys(dependencies);

  if (packageNames.length === 0) {
    return;
  }

  // Clear /node_modules and recreate it
  deleteDir(fs, "/node_modules");
  ensureDir(fs, "/node_modules");

  // Get shared module subpaths that need separate type resolution
  // e.g., "react/jsx-runtime" -> needs types for the jsx-runtime subpath
  const sharedSubpaths = new Map<string, Set<string>>();
  if (sharedModuleRegistry) {
    for (const moduleId of sharedModuleRegistry.list()) {
      const { packageName, subpath } = parseModuleId(moduleId);
      if (subpath && dependencies[packageName] === "shared") {
        if (!sharedSubpaths.has(packageName)) {
          sharedSubpaths.set(packageName, new Set());
        }
        sharedSubpaths.get(packageName)!.add(subpath);
      }
    }
  }

  // Install types for each dependency
  for (const [name, version] of Object.entries(dependencies)) {
    // Handle "shared" version specially - don't pass version to resolver
    // "shared" is used for host-provided shared modules
    const isShared = version === "shared";
    const resolverVersion = isShared ? undefined : version;
    const cacheKey = isShared ? `types:${name}@shared` : `types:${name}@${version}`;

    // Check cache first
    let resolved = await cache?.get(cacheKey);

    // Fetch if not cached
    if (!resolved && typesResolver) {
      try {
        // Use resolve() if available for full metadata
        if (typesResolver.resolve) {
          resolved = await typesResolver.resolve(name, resolverVersion) ?? undefined;
        } else {
          // Fall back to resolveTypes and construct ResolvedTypes
          const typeFiles = await typesResolver.resolveTypes(name, resolverVersion);
          if (Object.keys(typeFiles).length > 0) {
            // Transform VFS paths to relative paths
            const files: Record<string, string> = {};
            const prefix = `/node_modules/${name}/`;
            for (const [path, content] of Object.entries(typeFiles)) {
              const relativePath = path.startsWith(prefix) 
                ? path.slice(prefix.length) 
                : path;
              files[relativePath] = content;
            }
            resolved = {
              packageName: name,
              version: isShared ? "shared" : version,
              files,
              fromTypesPackage: false,
            };
          }
        }

        // Cache the result
        if (resolved && cache) {
          await cache.set(cacheKey, resolved);
        }
      } catch (err) {
        // Log but don't fail - types are nice to have but not required
        console.warn(`[sandlot] Failed to fetch types for "${name}@${version}":`, err);
      }
    }

    // Write to VFS
    if (resolved) {
      writePackageTypes(fs, name, resolved);
    }

    // For shared modules, also fetch types for subpaths (e.g., react/jsx-runtime)
    // These are stored in separate entries to avoid refetching the entire package
    if (isShared && typesResolver) {
      const subpaths = sharedSubpaths.get(name);
      if (subpaths) {
        for (const subpath of subpaths) {
          const subpathSpecifier = `${name}/${subpath}`;
          const subpathCacheKey = `types:${subpathSpecifier}@shared`;
          
          // Check cache first
          let subpathResolved = await cache?.get(subpathCacheKey);
          
          // Fetch if not cached
          if (!subpathResolved) {
            try {
              if (typesResolver.resolve) {
                subpathResolved = await typesResolver.resolve(subpathSpecifier) ?? undefined;
              } else {
                const typeFiles = await typesResolver.resolveTypes(subpathSpecifier);
                if (Object.keys(typeFiles).length > 0) {
                  const files: Record<string, string> = {};
                  const prefix = `/node_modules/${name}/`;
                  for (const [path, content] of Object.entries(typeFiles)) {
                    const relativePath = path.startsWith(prefix) 
                      ? path.slice(prefix.length) 
                      : path;
                    files[relativePath] = content;
                  }
                  subpathResolved = {
                    packageName: name,
                    version: "shared",
                    files,
                    fromTypesPackage: false,
                  };
                }
              }

              // Cache the result
              if (subpathResolved && cache) {
                await cache.set(subpathCacheKey, subpathResolved);
              }
            } catch (err) {
              console.warn(`[sandlot] Failed to fetch types for "${subpathSpecifier}":`, err);
            }
          }

          // Write subpath types to VFS (merge into existing package directory)
          if (subpathResolved) {
            writePackageTypes(fs, name, subpathResolved);
          }
        }
      }
    }
  }
}

/**
 * Parse a module ID into package name and optional subpath.
 * e.g., "react" -> { packageName: "react", subpath: undefined }
 * e.g., "react/jsx-runtime" -> { packageName: "react", subpath: "jsx-runtime" }
 * e.g., "@tanstack/react-query" -> { packageName: "@tanstack/react-query", subpath: undefined }
 * e.g., "@tanstack/react-query/devtools" -> { packageName: "@tanstack/react-query", subpath: "devtools" }
 */
function parseModuleId(moduleId: string): { packageName: string; subpath: string | undefined } {
  if (moduleId.startsWith("@")) {
    // Scoped package: @scope/name or @scope/name/subpath
    const parts = moduleId.split("/");
    if (parts.length >= 2) {
      const packageName = `${parts[0]}/${parts[1]}`;
      const subpath = parts.length > 2 ? parts.slice(2).join("/") : undefined;
      return { packageName, subpath };
    }
    return { packageName: moduleId, subpath: undefined };
  }

  // Regular package: name or name/subpath
  const slashIndex = moduleId.indexOf("/");
  if (slashIndex === -1) {
    return { packageName: moduleId, subpath: undefined };
  }

  return {
    packageName: moduleId.slice(0, slashIndex),
    subpath: moduleId.slice(slashIndex + 1),
  };
}

// =============================================================================
// Sandbox Context (dependencies from Sandlot)
// =============================================================================

export interface SandboxContext {
  bundler: IBundler;
  typechecker?: ITypechecker;
  typesResolver?: ITypesResolver;
  /** Cache for package types (used by ensureTypesInstalled) */
  packageTypesCache?: ICache<ResolvedTypes>;
  sharedModuleRegistry: ISharedModuleRegistry | null;
  executor?: IExecutor;
}

// =============================================================================
// Sandbox Implementation Factory
// =============================================================================

/**
 * Create a sandbox instance.
 * This is called by createSandlot().createSandbox().
 */
export async function createSandboxImpl(
  fs: Filesystem,
  options: SandboxOptions,
  context: SandboxContext
): Promise<Sandbox> {
  const {
    bundler,
    typechecker,
    typesResolver,
    packageTypesCache,
    sharedModuleRegistry,
    executor,
  } = context;

  // ---------------------------------------------------------------------------
  // Internal State
  // ---------------------------------------------------------------------------

  let lastBuild: BuildSuccess | null = null;
  const onBuildCallbacks = new Set<
    (result: BuildSuccess) => void | Promise<void>
  >();

  // Register initial onBuild callback if provided
  if (options.onBuild) {
    onBuildCallbacks.add(options.onBuild);
  }

  // ---------------------------------------------------------------------------
  // Initialize Filesystem
  // ---------------------------------------------------------------------------

  // Write initial files first (user-provided files take precedence)
  if (options.initialFiles) {
    for (const [path, content] of Object.entries(options.initialFiles)) {
      const normalizedPath = path.startsWith("/") ? path : `/${path}`;
      const dir = normalizedPath.substring(0, normalizedPath.lastIndexOf("/"));
      if (dir && dir !== "/") {
        ensureDir(fs, dir);
      }
      fs.writeFile(normalizedPath, content);
    }
  }

  // Ensure package.json exists (with default entry point)
  if (!fs.exists(PACKAGE_JSON_PATH)) {
    fs.writeFile(
      PACKAGE_JSON_PATH,
      JSON.stringify(DEFAULT_PACKAGE_JSON, null, 2)
    );
  }

  // Ensure tsconfig.json exists
  if (!fs.exists(TSCONFIG_PATH)) {
    fs.writeFile(TSCONFIG_PATH, JSON.stringify(DEFAULT_TSCONFIG, null, 2));
  }

  // ---------------------------------------------------------------------------
  // Add shared modules to package.json (types will be installed on typecheck)
  // ---------------------------------------------------------------------------

  if (sharedModuleRegistry) {
    const sharedModuleIds = sharedModuleRegistry.list();
    
    if (sharedModuleIds.length > 0) {
      // Read current dependencies
      const dependencies = getInstalledPackages(fs);
      
      // Add each shared module to dependencies
      for (const moduleId of sharedModuleIds) {
        // Extract package name (strip subpath)
        // e.g., "react-dom/client" -> "react-dom"
        let packageName = moduleId;
        
        if (moduleId.startsWith("@")) {
          const parts = moduleId.split("/");
          if (parts.length >= 2) {
            packageName = `${parts[0]}/${parts[1]}`;
          }
        } else {
          const slashIndex = moduleId.indexOf("/");
          if (slashIndex !== -1) {
            packageName = moduleId.slice(0, slashIndex);
          }
        }
        
        // Add to dependencies with "shared" version marker
        // (ensureTypesInstalled will handle this specially)
        // Always set to "shared" even if already present with a version -
        // shared modules take precedence since they're provided by the host
        dependencies[packageName] = "shared";
      }
      
      // Save updated dependencies
      saveInstalledPackages(fs, dependencies);
    }
  }

  // ---------------------------------------------------------------------------
  // Core Methods
  // ---------------------------------------------------------------------------

  /**
   * Install a package.
   * 
   * This only updates /package.json with the dependency.
   * Type definitions are fetched lazily when typecheck() is called.
   */
  async function install(packageSpec: string): Promise<InstallResult> {
    const { name, version } = parsePackageSpec(packageSpec);

    // Resolve version if not specified (lightweight HEAD request)
    let resolvedVersion = version;
    if (!resolvedVersion && typesResolver?.resolveVersion) {
      try {
        const resolved = await typesResolver.resolveVersion(name);
        resolvedVersion = resolved?.version ?? "latest";
      } catch {
        // Fall back to "latest" if version resolution fails
        resolvedVersion = "latest";
      }
    }
    resolvedVersion = resolvedVersion ?? "latest";

    // Update package.json
    const dependencies = getInstalledPackages(fs);
    const previousVersion = dependencies[name];
    dependencies[name] = resolvedVersion;
    saveInstalledPackages(fs, dependencies);

    return {
      name,
      version: resolvedVersion,
      previousVersion,
    };
  }

  /**
   * Uninstall a package
   */
  async function uninstall(packageName: string): Promise<UninstallResult> {
    const dependencies = getInstalledPackages(fs);

    if (!(packageName in dependencies)) {
      return { name: packageName, removed: false };
    }

    // Remove from dependencies
    delete dependencies[packageName];
    saveInstalledPackages(fs, dependencies);

    // Remove type files
    const typesPath = `/node_modules/${packageName}`;
    if (fs.exists(typesPath)) {
      fs.rm(typesPath, { recursive: true, force: true });
    }

    return { name: packageName, removed: true };
  }

  /**
   * Build the project
   */
  async function build(buildOptions?: SandboxBuildOptions): Promise<BuildResult> {
    // Get entry point: explicit option > package.json main > default
    const buildEntryPoint = buildOptions?.entryPoint ?? getEntryPoint(fs);
    const skipTypecheck = buildOptions?.skipTypecheck ?? false;
    const minify = buildOptions?.minify ?? false;
    const format = buildOptions?.format ?? "esm";

    // Step 1: Verify entry point exists
    if (!fs.exists(buildEntryPoint)) {
      return {
        success: false,
        phase: "entry",
        message: `Entry point not found: ${buildEntryPoint}`,
      };
    }

    // Step 2: Type check (unless skipped or no typechecker)
    if (!skipTypecheck && typechecker) {
      // Ensure all package types are installed before type checking
      await ensureTypesInstalled(fs, typesResolver, packageTypesCache, sharedModuleRegistry);

      const typecheckResult = await typechecker.typecheck({
        fs,
        entryPoint: buildEntryPoint,
        tsconfigPath: TSCONFIG_PATH,
      });

      if (!typecheckResult.success) {
        return {
          success: false,
          phase: "typecheck",
          diagnostics: typecheckResult.diagnostics,
        };
      }
    }

    // Step 3: Read installed packages and path aliases
    const installedPackages = getInstalledPackages(fs);
    const pathAliases = getPathAliases(fs);

    // Step 4: Bundle
    const bundleResult = await bundler.bundle({
      fs,
      entryPoint: buildEntryPoint,
      installedPackages,
      sharedModules: sharedModuleRegistry?.list() ?? [],
      sharedModuleRegistry: sharedModuleRegistry ?? undefined,
      pathAliases,
      format,
      minify,
    });

    // Check for bundle errors
    if (!bundleResult.success) {
      return {
        success: false,
        phase: "bundle",
        bundleErrors: bundleResult.errors,
        bundleWarnings: bundleResult.warnings,
      };
    }

    // Step 5: Process Tailwind CSS (if enabled)
    let finalCode = bundleResult.code;
    if (buildOptions?.tailwind) {
      try {
        const tailwindOptions: TailwindOptions = 
          typeof buildOptions.tailwind === "boolean" 
            ? {} 
            : buildOptions.tailwind;
        
        const tailwindInjection = await processTailwind(
          fs, 
          bundleResult.includedFiles, 
          tailwindOptions
        );
        
        // Prepend Tailwind CSS injection to the bundle
        finalCode = tailwindInjection + "\n" + bundleResult.code;
      } catch (err) {
        // Tailwind processing failed - return as bundle error
        return {
          success: false,
          phase: "bundle",
          bundleErrors: [{
            text: `Tailwind processing failed: ${err instanceof Error ? err.message : String(err)}`,
          }],
          bundleWarnings: bundleResult.warnings,
        };
      }
    }

    // Step 6: Create build output (no loading/execution - that's the executor's job)
    const output: BuildSuccess = {
      success: true,
      code: finalCode,
      includedFiles: bundleResult.includedFiles,
      warnings: bundleResult.warnings,
    };

    // Step 7: Update lastBuild and fire callbacks
    lastBuild = output;
    for (const callback of onBuildCallbacks) {
      try {
        await callback(output);
      } catch (err) {
        console.error("[sandlot] onBuild callback error:", err);
      }
    }

    return output;
  }

  /**
   * Type check the project.
   * 
   * This function:
   * 1. Ensures all package types are installed in /node_modules (from cache or network)
   * 2. Runs the TypeScript type checker
   */
  async function typecheck(
    typecheckOptions?: SandboxTypecheckOptions
  ): Promise<TypecheckResult> {
    // Ensure all package types are installed before type checking
    await ensureTypesInstalled(fs, typesResolver, packageTypesCache, sharedModuleRegistry);

    if (!typechecker) {
      // No typechecker configured - return success with no diagnostics
      return { success: true, diagnostics: [] };
    }

    // Get entry point: explicit option > package.json main > default
    const checkEntryPoint = typecheckOptions?.entryPoint ?? getEntryPoint(fs);

    // Verify entry point exists
    if (!fs.exists(checkEntryPoint)) {
      return {
        success: false,
        diagnostics: [
          {
            message: `Entry point not found: ${checkEntryPoint}`,
            severity: "error",
          },
        ],
      };
    }

    return typechecker.typecheck({
      fs,
      entryPoint: checkEntryPoint,
      tsconfigPath: TSCONFIG_PATH,
    });
  }

  /**
   * Build and run code using the configured executor.
   */
  async function run(runOptions?: RunOptions): Promise<RunResult> {
    // Ensure executor is configured
    if (!executor) {
      throw new Error(
        "[sandlot] No executor configured. Provide an executor when creating Sandlot to use run()."
      );
    }

    // Step 1: Build the code
    const buildResult = await build({
      entryPoint: runOptions?.entryPoint,
      skipTypecheck: runOptions?.skipTypecheck,
      tailwind: runOptions?.tailwind,
    });

    // If build failed, return early with build failure info
    if (!buildResult.success) {
      return {
        success: false,
        logs: [],
        error: buildResult.message ?? `Build failed in ${buildResult.phase} phase`,
        buildFailure: {
          phase: buildResult.phase,
          message: buildResult.message,
          diagnostics: buildResult.diagnostics,
          bundleErrors: buildResult.bundleErrors,
          bundleWarnings: buildResult.bundleWarnings,
        },
      };
    }

    // Step 2: Execute via the executor
    const executeResult = await executor.execute(buildResult.code, {
      entryExport: runOptions?.entryExport ?? "main",
      context: runOptions?.context,
      timeout: runOptions?.timeout,
    });

    // Return the execution result
    return {
      success: executeResult.success,
      logs: executeResult.logs,
      returnValue: executeResult.returnValue,
      error: executeResult.error,
      executionTimeMs: executeResult.executionTimeMs,
    };
  }

  // ---------------------------------------------------------------------------
  // Shell Environment (lazy initialization)
  // ---------------------------------------------------------------------------

  // Create a SandboxRef for commands to use
  const sandboxRef: SandboxRef = {
    fs,
    install,
    uninstall,
    build,
    typecheck,
    run,
  };

  // Lazily initialized Bash instance
  let bashInstance: Bash | null = null;

  function getBash(): Bash {
    if (!bashInstance) {
      const commands = createDefaultCommands(sandboxRef);
      bashInstance = new Bash({
        cwd: "/",
        fs: wrapFilesystemForJustBash(fs),
        customCommands: commands,
      });
    }
    return bashInstance;
  }

  /**
   * Execute a shell command using just-bash.
   *
   * Supports standard bash commands (echo, cat, cd, etc.) plus:
   *   - sandlot build [options]
   *   - sandlot typecheck [options]
   *   - sandlot install <pkg> [...]
   *   - sandlot uninstall <pkg> [...]
   *   - sandlot help
   */
  async function exec(command: string): Promise<ExecResult> {
    const bash = getBash();
    const result = await bash.exec(command);
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  // ---------------------------------------------------------------------------
  // Return Sandbox Interface
  // ---------------------------------------------------------------------------

  return {
    fs,

    exec,

    get lastBuild() {
      return lastBuild;
    },

    getState(): SandboxState {
      return { files: fs.getFiles() };
    },

    onBuild(callback) {
      onBuildCallbacks.add(callback);
      return () => {
        onBuildCallbacks.delete(callback);
      };
    },

    // Direct methods
    install,
    uninstall,
    build,
    typecheck,
    run,

    // File operations (fs handles path normalization and parent dir creation)
    readFile: (path: string, options?: { offset?: number; limit?: number }) => fs.readFile(path, options),
    readFileRaw: (path: string) => fs.readFileRaw(path),
    writeFile: (path: string, content: string) => fs.writeFile(path, content),
    editFile: (path: string, options: { oldString: string; newString: string; replaceAll?: boolean }) => fs.editFile(path, options),
  };
}
