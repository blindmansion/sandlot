/**
 * Sandbox implementation for v2.
 *
 * A sandbox is a single-project environment with its own:
 * - Virtual filesystem (sync)
 * - Installed packages (tracked in /package.json)
 * - Build configuration (entry point, tsconfig)
 * - Validation function
 *
 * The sandbox exposes both direct methods (install, build, etc.) and
 * shell commands via exec() for flexibility.
 */

import type {
  IBundler,
  ITypechecker,
  ITypesResolver,
  ISharedModuleRegistry,
  Sandbox,
  SandboxOptions,
  SandboxState,
  SandboxBuildOptions,
  SandboxTypecheckOptions,
  BuildOutput,
  InstallResult,
  UninstallResult,
  TypecheckResult,
  ExecResult,
  BundleResult,
} from "../types";
import { Filesystem } from "./fs";

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
      const content = fs.readFile(PACKAGE_JSON_PATH);
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
 * Save installed packages to /package.json
 */
function saveInstalledPackages(
  fs: Filesystem,
  dependencies: Record<string, string>
): void {
  let existing: Record<string, unknown> = {};

  try {
    if (fs.exists(PACKAGE_JSON_PATH)) {
      const content = fs.readFile(PACKAGE_JSON_PATH);
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

// =============================================================================
// Module Loader
// =============================================================================

/**
 * Load a bundled module by creating a blob URL and importing it
 */
async function loadModule(
  bundleResult: BundleResult
): Promise<Record<string, unknown>> {
  const blob = new Blob([bundleResult.code], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    // @vite-ignore prevents Vite from analyzing this dynamic import
    const module = await import(/* @vite-ignore */ url);
    return module as Record<string, unknown>;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// =============================================================================
// Sandbox Context (dependencies from Sandlot)
// =============================================================================

export interface SandboxContext {
  bundler: IBundler;
  typechecker?: ITypechecker;
  typesResolver?: ITypesResolver;
  sharedModuleRegistry: ISharedModuleRegistry | null;
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
    sharedModuleRegistry,
  } = context;

  // ---------------------------------------------------------------------------
  // Internal State
  // ---------------------------------------------------------------------------

  let lastBuild: BuildOutput | null = null;
  const onBuildCallbacks = new Set<
    (result: BuildOutput) => void | Promise<void>
  >();
  let validationFn: ((module: Record<string, unknown>) => unknown) | null = null;

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
  // Core Methods
  // ---------------------------------------------------------------------------

  /**
   * Install a package
   */
  async function install(packageSpec: string): Promise<InstallResult> {
    const { name, version } = parsePackageSpec(packageSpec);

    // Resolve version and fetch types
    let resolvedVersion = version ?? "latest";
    let typesInstalled = false;
    let typeFilesCount = 0;
    let typesError: string | undefined;
    const fromCache = false;

    // If typesResolver is available, use it to get type definitions
    if (typesResolver) {
      try {
        const typeFiles = await typesResolver.resolveTypes(name, version);

        // Write type files to node_modules
        const packageDir = `/node_modules/${name}`;
        ensureDir(fs, packageDir);

        for (const [filePath, content] of Object.entries(typeFiles)) {
          const fullPath = filePath.startsWith("/")
            ? filePath
            : `${packageDir}/${filePath}`;
          const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
          ensureDir(fs, dir);
          fs.writeFile(fullPath, content);
          typeFilesCount++;
        }

        typesInstalled = typeFilesCount > 0;

        // Try to extract version from type files or use provided
        if (!version) {
          resolvedVersion = "latest";
        }
      } catch (err) {
        typesError = err instanceof Error ? err.message : String(err);
      }
    }

    // Update package.json
    const dependencies = getInstalledPackages(fs);
    dependencies[name] = resolvedVersion;
    saveInstalledPackages(fs, dependencies);

    return {
      name,
      version: resolvedVersion,
      typesInstalled,
      typeFilesCount,
      typesError,
      fromCache,
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
  async function build(buildOptions?: SandboxBuildOptions): Promise<BuildOutput> {
    // Get entry point: explicit option > package.json main > default
    const buildEntryPoint = buildOptions?.entryPoint ?? getEntryPoint(fs);
    const skipTypecheck = buildOptions?.skipTypecheck ?? false;
    const minify = buildOptions?.minify ?? false;
    const format = buildOptions?.format ?? "esm";

    // Verify entry point exists
    if (!fs.exists(buildEntryPoint)) {
      throw new Error(`Entry point not found: ${buildEntryPoint}`);
    }

    // Step 1: Type check (unless skipped or no typechecker)
    if (!skipTypecheck && typechecker) {
      const typecheckResult = await typechecker.typecheck({
        fs,
        entryPoint: buildEntryPoint,
        tsconfigPath: TSCONFIG_PATH,
      });

      if (!typecheckResult.success) {
        const errors = typecheckResult.diagnostics
          .filter((d) => d.severity === "error")
          .map((d) => {
            const loc = d.file ? `${d.file}:${d.line ?? 1}:${d.column ?? 1}` : "";
            return loc ? `${loc}: ${d.message}` : d.message;
          })
          .join("\n");

        throw new Error(`Type check failed:\n${errors}`);
      }
    }

    // Step 2: Read installed packages
    const installedPackages = getInstalledPackages(fs);

    // Step 3: Bundle
    const bundleResult = await bundler.bundle({
      fs,
      entryPoint: buildEntryPoint,
      installedPackages,
      sharedModules: sharedModuleRegistry?.list() ?? [],
      sharedModuleRegistry: sharedModuleRegistry ?? undefined,
      format,
      minify,
    });

    // Step 4: Load module
    let loadedModule: Record<string, unknown>;
    try {
      loadedModule = await loadModule(bundleResult);
    } catch (err) {
      throw new Error(
        `Failed to load module: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Step 5: Validate (if validation function is set)
    let validatedModule = loadedModule;
    if (validationFn) {
      try {
        const result = validationFn(loadedModule);
        validatedModule =
          result && typeof result === "object"
            ? (result as Record<string, unknown>)
            : loadedModule;
      } catch (err) {
        throw new Error(
          `Validation failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Step 6: Create build output
    const output: BuildOutput = {
      bundle: bundleResult,
      module: validatedModule,
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
   * Type check the project
   */
  async function typecheck(
    typecheckOptions?: SandboxTypecheckOptions
  ): Promise<TypecheckResult> {
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
   * Execute a shell command (placeholder - will be implemented with just-bash)
   */
  async function exec(_command: string): Promise<ExecResult> {
    // TODO: Implement with just-bash custom commands
    // For now, return a placeholder
    return {
      exitCode: 1,
      stdout: "",
      stderr: "exec() not yet implemented - use direct methods instead",
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

    setValidation(fn) {
      validationFn = fn;
    },

    clearValidation() {
      validationFn = null;
    },

    // Direct methods
    install,
    uninstall,
    build,
    typecheck,

    // File operations (sync, exposed as sync)
    readFile(path: string): string {
      const normalizedPath = path.startsWith("/") ? path : `/${path}`;
      return fs.readFile(normalizedPath);
    },

    writeFile(path: string, content: string): void {
      const normalizedPath = path.startsWith("/") ? path : `/${path}`;
      const dir = normalizedPath.substring(0, normalizedPath.lastIndexOf("/"));
      if (dir && dir !== "/") {
        ensureDir(fs, dir);
      }
      fs.writeFile(normalizedPath, content);
    },
  };
}
