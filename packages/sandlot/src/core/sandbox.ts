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
} from "../types";
import { Filesystem, wrapFilesystemForJustBash } from "./fs";
import { createDefaultCommands, type SandboxRef } from "../commands";

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
// Sandbox Context (dependencies from Sandlot)
// =============================================================================

export interface SandboxContext {
  bundler: IBundler;
  typechecker?: ITypechecker;
  typesResolver?: ITypesResolver;
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

    // Step 3: Read installed packages
    const installedPackages = getInstalledPackages(fs);

    // Step 4: Bundle
    const bundleResult = await bundler.bundle({
      fs,
      entryPoint: buildEntryPoint,
      installedPackages,
      sharedModules: sharedModuleRegistry?.list() ?? [],
      sharedModuleRegistry: sharedModuleRegistry ?? undefined,
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

    // Step 5: Create build output (no loading/execution - that's the executor's job)
    const output: BuildSuccess = {
      success: true,
      code: bundleResult.code,
      includedFiles: bundleResult.includedFiles,
      warnings: bundleResult.warnings,
    };

    // Step 6: Update lastBuild and fire callbacks
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
    readFile: (path: string) => fs.readFile(path),
    writeFile: (path: string, content: string) => fs.writeFile(path, content),
  };
}
