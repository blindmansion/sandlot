import type { IFileSystem, FsEntry, FsStat } from "just-bash/browser";
import type { Filesystem } from "./core/fs";

// =============================================================================
// Re-export filesystem types for convenience
// =============================================================================

export type { IFileSystem, FsEntry, FsStat } from "just-bash/browser";
export type { Filesystem } from "./core/fs";

// =============================================================================
// Bundler Interface
// =============================================================================

/**
 * Bundler interface - transforms source files into executable JavaScript.
 *
 * Implementations handle their own initialization and caching (e.g., WASM loading).
 */
export interface IBundler {
  /**
   * Bundle source files from a filesystem into a single output
   */
  bundle(options: BundleOptions): Promise<BundleResult>;
}

export interface BundleOptions {
  fs: Filesystem;
  entryPoint: string;

  /**
   * Map of installed package names to versions.
   * Used by the bundler to resolve imports to specific versions.
   *
   * @example { "lodash": "4.17.21", "react": "18.2.0" }
   */
  installedPackages?: Record<string, string>;

  /**
   * Module IDs that resolve to shared modules instead of bundling.
   * These are provided by the host environment at runtime.
   */
  sharedModules?: string[];

  /** Shared module registry for resolving shared imports */
  sharedModuleRegistry?: ISharedModuleRegistry;

  /** Modules to treat as external (don't bundle or rewrite) */
  external?: string[];

  format?: "esm" | "iife" | "cjs";
  minify?: boolean;
  sourcemap?: boolean;
  target?: string[];
}

/**
 * Bundle result - success or failure with structured errors.
 */
export type BundleResult = BundleSuccess | BundleFailure;

export interface BundleSuccess {
  success: true;
  code: string;
  warnings: BundleWarning[];
  includedFiles: string[];
}

export interface BundleFailure {
  success: false;
  errors: BundleError[];
  warnings: BundleWarning[];
}

export interface BundleWarning {
  text: string;
  location?: BundleLocation;
}

export interface BundleError {
  text: string;
  location?: BundleLocation;
}

export interface BundleLocation {
  file: string;
  line: number;
  column?: number;
  /** The source line text (if available from esbuild) */
  lineText?: string;
}

// =============================================================================
// Typechecker Interface
// =============================================================================

/**
 * Typechecker interface - validates TypeScript code.
 *
 * Implementations handle their own lib file loading and caching.
 */
export interface ITypechecker {
  /**
   * Type check files against a virtual filesystem
   */
  typecheck(options: TypecheckOptions): Promise<TypecheckResult>;
}

export interface TypecheckOptions {
  /** Sync filesystem to read source files from */
  fs: Filesystem;
  /** Entry point path (absolute path in the filesystem) */
  entryPoint: string;
  /** Path to tsconfig.json (default: "/tsconfig.json") */
  tsconfigPath?: string;
}

export interface TypecheckResult {
  success: boolean;
  diagnostics: Diagnostic[];
}

export interface Diagnostic {
  file?: string;
  line?: number;
  column?: number;
  message: string;
  severity: "error" | "warning" | "info";
}

// =============================================================================
// Types Resolver Interface
// =============================================================================

/**
 * Types resolver interface - fetches type definitions for npm packages.
 *
 * Implementations handle their own caching (in-memory, KV, R2, etc.).
 */
export interface ITypesResolver {
  /**
   * Fetch type definitions for a package.
   * Returns a map of file paths to content for .d.ts files.
   */
  resolveTypes(
    packageName: string,
    version?: string
  ): Promise<Record<string, string>>;
}

// =============================================================================
// Shared Module Registry Interface
// =============================================================================

/**
 * Shared module registry interface - provides host modules to bundled code.
 *
 * This allows dynamic code to use the same React/library instances as the host,
 * avoiding the "multiple React instances" problem.
 *
 * Each registry instance has a unique key for global exposure, allowing multiple
 * Sandlot instances to coexist without sharing module state.
 */
export interface ISharedModuleRegistry {
  /**
   * The unique global key where this registry is exposed.
   * Bundled code accesses the registry via `globalThis[registryKey]`.
   */
  readonly registryKey: string;

  /**
   * Get a registered module by ID
   */
  get(moduleId: string): unknown;

  /**
   * Check if a module is registered
   */
  has(moduleId: string): boolean;

  /**
   * Get export names for a module (for generating re-exports)
   */
  getExportNames(moduleId: string): string[];

  /**
   * List all registered module IDs
   */
  list(): string[];
}

// =============================================================================
// Sandlot Configuration
// =============================================================================

export interface SandlotOptions {
  /**
   * Bundler implementation.
   * Handles its own initialization and WASM loading.
   */
  bundler: IBundler;

  /**
   * Typechecker implementation (optional - skip type checking if not provided).
   * Handles its own TypeScript lib file loading and caching.
   */
  typechecker?: ITypechecker;

  /**
   * Types resolver for npm packages (optional).
   * Handles its own caching. If not provided, `install` command won't fetch types.
   */
  typesResolver?: ITypesResolver;

  /**
   * Shared modules - host modules to share with sandboxed code.
   * Keys are import specifiers, values are the actual module objects.
   *
   * @example { 'react': React, 'react-dom/client': ReactDOM }
   */
  sharedModules?: Record<string, unknown>;

  /**
   * Default options for sandboxes created from this instance
   */
  sandboxDefaults?: {
    maxFilesystemSize?: number;
  };
}

// =============================================================================
// Sandbox Types
// =============================================================================

export interface SandboxOptions {
  /**
   * Initial files to populate the filesystem with.
   *
   * If `/package.json` is not provided, a default one will be created with:
   * ```json
   * { "main": "./index.ts", "dependencies": {} }
   * ```
   *
   * If `/tsconfig.json` is not provided, sensible defaults will be created.
   *
   * The `main` field in package.json determines the entry point for build/typecheck.
   */
  initialFiles?: Record<string, string>;

  /**
   * Maximum filesystem size in bytes
   */
  maxFilesystemSize?: number;

  /**
   * Callback invoked when a build succeeds
   */
  onBuild?: (result: BuildOutput) => void | Promise<void>;
}

/**
 * Build result - success or failure with structured errors.
 *
 * On success, contains the bundle and loaded module.
 * On failure, contains the phase that failed and structured error information.
 */
export type BuildResult = BuildSuccess | BuildFailure;

export interface BuildSuccess {
  success: true;
  bundle: BundleSuccess;
  module: Record<string, unknown>;
}

export interface BuildFailure {
  success: false;
  /** Which phase of the build failed */
  phase: "entry" | "typecheck" | "bundle" | "load" | "validation";
  /** Error message (for entry/load/validation failures) */
  message?: string;
  /** Type check diagnostics (for typecheck failures) */
  diagnostics?: Diagnostic[];
  /** Bundle errors (for bundle failures) */
  bundleErrors?: BundleError[];
  /** Bundle warnings (may be present even on failure) */
  bundleWarnings?: BundleWarning[];
}

/**
 * Legacy alias for BuildSuccess.
 * @deprecated Use BuildResult and check success flag instead.
 */
export type BuildOutput = BuildSuccess;

// -----------------------------------------------------------------------------
// Install/Uninstall Types
// -----------------------------------------------------------------------------

export interface InstallResult {
  /** Package name */
  name: string;
  /** Resolved version */
  version: string;
  /** Whether type definitions were installed */
  typesInstalled: boolean;
  /** Number of .d.ts files written */
  typeFilesCount: number;
  /** Whether types came from cache */
  fromCache?: boolean;
  /** Error message if types failed to install */
  typesError?: string;
}

export interface UninstallResult {
  /** Package name */
  name: string;
  /** Whether the package was installed (and thus removed) */
  removed: boolean;
}

// -----------------------------------------------------------------------------
// Build Options
// -----------------------------------------------------------------------------

export interface SandboxBuildOptions {
  /**
   * Entry point to build.
   * If not specified, reads from `main` field in /package.json.
   * Falls back to "./index.ts" if not found.
   */
  entryPoint?: string;

  /**
   * Skip type checking before bundling.
   * @default false
   */
  skipTypecheck?: boolean;

  /**
   * Minify the output.
   * @default false
   */
  minify?: boolean;

  /**
   * Output format.
   * @default "esm"
   */
  format?: "esm" | "iife" | "cjs";
}

// -----------------------------------------------------------------------------
// Typecheck Options
// -----------------------------------------------------------------------------

export interface SandboxTypecheckOptions {
  /**
   * Entry point to typecheck.
   * If not specified, reads from `main` field in /package.json.
   * Falls back to "./index.ts" if not found.
   */
  entryPoint?: string;
}

// -----------------------------------------------------------------------------
// Sandbox Interface
// -----------------------------------------------------------------------------

export interface Sandbox {
  /**
   * The virtual filesystem (sync)
   */
  readonly fs: Filesystem;

  /**
   * Execute a shell command
   */
  exec(command: string): Promise<ExecResult>;

  /**
   * The last successful build output
   */
  readonly lastBuild: BuildOutput | null;

  /**
   * Get the current sandbox state for persistence
   */
  getState(): SandboxState;

  // ---------------------------------------------------------------------------
  // File Operations (convenience methods)
  // ---------------------------------------------------------------------------

  /**
   * Read a file from the virtual filesystem.
   *
   * @param path - Absolute path to the file (e.g., "/src/app.ts")
   * @returns File contents as a string
   * @throws If the file does not exist
   */
  readFile(path: string): string;

  /**
   * Write a file to the virtual filesystem.
   * Creates parent directories automatically if they don't exist.
   *
   * @param path - Absolute path to the file (e.g., "/src/app.ts")
   * @param content - File contents to write
   */
  writeFile(path: string, content: string): void;

  /**
   * Subscribe to build events
   */
  onBuild(callback: (result: BuildOutput) => void | Promise<void>): () => void;

  /**
   * Set a validation function for the build command
   */
  setValidation(fn: (module: Record<string, unknown>) => unknown): void;

  /**
   * Clear the validation function
   */
  clearValidation(): void;

  // ---------------------------------------------------------------------------
  // Direct Methods (also available via exec)
  // ---------------------------------------------------------------------------

  /**
   * Install a package from npm.
   * Updates /package.json and fetches type definitions if typesResolver is configured.
   *
   * @param packageSpec - Package specifier (e.g., "lodash", "lodash@4.17.21", "@types/node@20")
   * @returns Installation result with version and types info
   *
   * @example
   * await sandbox.install("lodash@4.17.21");
   * await sandbox.install("@tanstack/react-query");
   */
  install(packageSpec: string): Promise<InstallResult>;

  /**
   * Uninstall a package.
   * Removes from /package.json and deletes type definition files.
   *
   * @param packageName - Package name (e.g., "lodash", "@tanstack/react-query")
   * @returns Whether the package was removed
   */
  uninstall(packageName: string): Promise<UninstallResult>;

  /**
   * Build the project.
   * Reads dependencies from /package.json, optionally typechecks, bundles,
   * loads the module, runs validation, and fires onBuild callbacks.
   *
   * @param options - Build options
   * @returns Build result - check `success` field to determine outcome
   */
  build(options?: SandboxBuildOptions): Promise<BuildResult>;

  /**
   * Type check the project.
   * Reads tsconfig from filesystem and runs the typechecker.
   *
   * @param options - Typecheck options
   * @returns Typecheck result with diagnostics
   */
  typecheck(options?: SandboxTypecheckOptions): Promise<TypecheckResult>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxState {
  files: Record<string, string>;
}

// =============================================================================
// Sandlot Interface
// =============================================================================

export interface Sandlot {
  /**
   * Create a new sandbox environment
   */
  createSandbox(options?: SandboxOptions): Promise<Sandbox>;

  /**
   * The shared module registry (if shared modules were provided)
   */
  readonly sharedModules: ISharedModuleRegistry | null;
}
