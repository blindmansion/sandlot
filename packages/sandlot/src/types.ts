import type { Filesystem } from "./core/fs";
import type { IPersistor } from "./core/persistor";

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

  /**
   * Dispose of resources held by the bundler (optional).
   * Called by Sandlot.dispose() to clean up background services.
   */
  dispose?(): Promise<void>;
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

  /**
   * Path aliases for module resolution (from tsconfig.json paths).
   * Maps alias patterns to target paths.
   * 
   * @example { "@/*": ["/src/*"] }
   */
  pathAliases?: Record<string, string[]>;

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
// Executor Interface
// =============================================================================

/**
 * Executor interface - runs bundled code in an isolated context.
 *
 * Different implementations provide different isolation levels:
 * - MainThreadExecutor: Runs in the main thread (no isolation, for trusted code)
 * - WorkerExecutor: Runs in a Web Worker (memory isolation, can be terminated)
 * - IframeExecutor: Runs in a sandboxed iframe (DOM isolation, CSP control)
 *
 * The executor receives a code string (bundled JavaScript) and options,
 * and returns the execution result including captured logs and return value.
 */
export interface IExecutor {
  /**
   * Execute bundled code and return the result.
   *
   * @param code - The bundled JavaScript code to execute
   * @param options - Execution options (entry export, context, timeout)
   * @returns Execution result with logs, return value, and any error
   */
  execute(code: string, options?: ExecuteOptions): Promise<ExecuteResult>;
}

/**
 * Options for code execution.
 */
export interface ExecuteOptions {
  /**
   * Which export to call:
   * - 'main': Calls `main(context)` export with the provided context
   * - 'default': Calls the default export (no arguments)
   *
   * If neither export exists, top-level code still runs on import.
   * @default 'main'
   */
  entryExport?: "main" | "default";

  /**
   * Context object passed to `main(context)` when entryExport is 'main'.
   * Typically includes things like args, env, logging functions.
   */
  context?: Record<string, unknown>;

  /**
   * Execution timeout in milliseconds.
   * Set to 0 to disable timeout.
   * @default 30000
   */
  timeout?: number;
}

/**
 * Result of code execution.
 */
export interface ExecuteResult {
  /** Whether execution completed successfully */
  success: boolean;

  /** Captured console output (log, warn, error, info, debug) */
  logs: string[];

  /** Return value from the executed function (if any) */
  returnValue?: unknown;

  /** Error message if execution failed */
  error?: string;

  /** Execution time in milliseconds */
  executionTimeMs?: number;
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
   * Executor implementation (optional).
   * Handles running bundled code in an appropriate context.
   * If not provided, sandbox.run() will throw an error.
   */
  executor?: IExecutor;

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
   * Unified cache provider.
   * If provided, used to create typechecker and typesResolver with shared caching.
   * If typechecker/typesResolver are also provided, they take precedence.
   */
  persistor?: IPersistor;

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
  onBuild?: (result: BuildSuccess) => void | Promise<void>;
}

/**
 * Build phases that can fail.
 */
export type BuildPhase = "entry" | "typecheck" | "bundle";

/**
 * Build result - success or failure with structured errors.
 *
 * On success, contains the bundled code string.
 * On failure, contains the phase that failed and structured error information.
 *
 * Note: Build does NOT load or execute the module. Use an executor to run the code.
 * This keeps the build phase pure (no code execution) and allows different execution
 * contexts (main thread, web worker, iframe, remote server).
 */
export type BuildResult = BuildSuccess | BuildFailure;

export interface BuildSuccess {
  success: true;
  /** The bundled JavaScript code */
  code: string;
  /** Files that were included in the bundle */
  includedFiles: string[];
  /** Any warnings from the bundler */
  warnings: BundleWarning[];
}

/**
 * Details about why a build failed.
 * Used by both BuildResult and RunResult.
 */
export interface BuildFailureDetails {
  /** Which phase of the build failed */
  phase: BuildPhase;
  /** Error message (for entry failures) */
  message?: string;
  /** Type check diagnostics (for typecheck failures) */
  diagnostics?: Diagnostic[];
  /** Bundle errors (for bundle failures) */
  bundleErrors?: BundleError[];
  /** Bundle warnings (may be present even on failure) */
  bundleWarnings?: BundleWarning[];
}

export interface BuildFailure extends BuildFailureDetails {
  success: false;
}


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
  /** Number of HTTP requests made to fetch types */
  requestCount?: number;
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

  /**
   * Enable Tailwind CSS processing.
   * 
   * When enabled, scans bundled files for Tailwind classes and generates
   * the corresponding CSS, which is injected into the bundle.
   * 
   * Uses tailwindcss-iso which works in both browser and Node.js environments.
   * 
   * @default false
   * 
   * @example
   * // Simple usage - just enable Tailwind
   * await sandbox.build({ tailwind: true });
   * 
   * @example
   * // With custom theme
   * await sandbox.build({
   *   tailwind: {
   *     css: `@theme { --color-primary: #3b82f6; }`
   *   }
   * });
   */
  tailwind?: boolean | TailwindOptions;
}

/**
 * Options for Tailwind CSS processing.
 */
export interface TailwindOptions {
  /**
   * Additional CSS to include in output (e.g., @theme directives for custom themes).
   * 
   * @example
   * ```css
   * @theme {
   *   --color-primary: #3b82f6;
   *   --font-sans: "Inter", sans-serif;
   * }
   * ```
   */
  css?: string;

  /**
   * Tailwind import statement. Can include modifiers like important(#app).
   * @default '@import "tailwindcss";'
   * 
   * @example '@import "tailwindcss" important(#app);'
   */
  importCSS?: string;
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
// Run Options and Result
// -----------------------------------------------------------------------------

/**
 * Options for running code in the sandbox.
 */
export interface RunOptions {
  /**
   * Entry point to build and run.
   * If not specified, reads from `main` field in /package.json.
   * Falls back to "./index.ts" if not found.
   */
  entryPoint?: string;

  /**
   * Skip type checking before building.
   * @default false
   */
  skipTypecheck?: boolean;

  /**
   * Enable Tailwind CSS processing.
   * @default false
   */
  tailwind?: boolean | TailwindOptions;

  /**
   * Which export to call:
   * - 'main': Calls `main(context)` export with the provided context
   * - 'default': Calls the default export (no arguments)
   * @default 'main'
   */
  entryExport?: "main" | "default";

  /**
   * Context object passed to `main(context)` when entryExport is 'main'.
   */
  context?: Record<string, unknown>;

  /**
   * Execution timeout in milliseconds.
   * Set to 0 to disable timeout.
   * @default 30000
   */
  timeout?: number;
}

/**
 * Result of running code in the sandbox.
 *
 * Extends ExecuteResult with build failure information.
 * If `buildFailure` is present, the build failed before execution.
 */
export interface RunResult extends ExecuteResult {
  /** If build failed, contains failure details (same structure as BuildFailure) */
  buildFailure?: BuildFailureDetails;
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
   * The last successful build result (code string + metadata)
   */
  readonly lastBuild: BuildSuccess | null;

  /**
   * Get the current sandbox state for persistence
   */
  getState(): SandboxState;

  // ---------------------------------------------------------------------------
  // File Operations (convenience methods)
  // ---------------------------------------------------------------------------

  /**
   * Read a file from the virtual filesystem.
   * Returns content with line numbers (cat -n format).
   * Lines longer than 2000 chars are truncated.
   *
   * @param path - Absolute path to the file (e.g., "/src/app.ts")
   * @param options - Optional offset (0-based line number) and limit (number of lines)
   * @returns File contents with line numbers
   * @throws If the file does not exist
   * 
   * @example
   * ```ts
   * // Read entire file with line numbers
   * sandbox.readFile('/src/app.ts');
   * // Output:
   * //      1|import React from 'react';
   * //      2|
   * //      3|export function App() {
   * 
   * // Read lines 10-19 (10 lines starting at offset 10)
   * sandbox.readFile('/src/app.ts', { offset: 10, limit: 10 });
   * ```
   */
  readFile(path: string, options?: { offset?: number; limit?: number }): string;

  /**
   * Read raw file content without line numbers.
   * Use this when you need the actual file content for processing.
   *
   * @param path - Absolute path to the file (e.g., "/src/app.ts")
   * @returns File contents as a string (no line numbers)
   * @throws If the file does not exist
   */
  readFileRaw(path: string): string;

  /**
   * Write a file to the virtual filesystem.
   * Creates parent directories automatically if they don't exist.
   * Overwrites the entire file.
   *
   * @param path - Absolute path to the file (e.g., "/src/app.ts")
   * @param content - File contents to write
   */
  writeFile(path: string, content: string): void;

  /**
   * Edit a file using string replacement.
   * Fails if oldString is not found or found multiple times (unless replaceAll is true).
   *
   * @param path - Absolute path to the file (e.g., "/src/app.ts")
   * @param options - oldString to find, newString to replace with, optional replaceAll flag
   * @throws If oldString is not found
   * @throws If oldString is found multiple times and replaceAll is false
   * 
   * @example
   * ```ts
   * // Replace a single occurrence
   * sandbox.editFile('/src/app.ts', {
   *   oldString: 'const x = 1;',
   *   newString: 'const x = 42;'
   * });
   * 
   * // Replace all occurrences
   * sandbox.editFile('/src/app.ts', {
   *   oldString: 'TODO',
   *   newString: 'DONE',
   *   replaceAll: true
   * });
   * ```
   */
  editFile(path: string, options: { oldString: string; newString: string; replaceAll?: boolean }): void;

  /**
   * Subscribe to build events
   */
  onBuild(callback: (result: BuildSuccess) => void | Promise<void>): () => void;

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
   * Reads dependencies from /package.json, optionally typechecks, and bundles.
   * Returns the bundled code string (does NOT execute it).
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

  /**
   * Build and run code using the configured executor.
   *
   * This is a convenience method that:
   * 1. Builds the code (typecheck + bundle)
   * 2. Passes the bundled code to the executor
   * 3. Returns the execution result
   *
   * Requires an executor to be configured when creating Sandlot.
   *
   * @param options - Run options (entry point, context, timeout, etc.)
   * @returns Run result with logs, return value, and any error
   * @throws If no executor was configured
   *
   * @example
   * ```ts
   * // Script style - top-level code runs on import
   * sandbox.writeFile('/index.ts', 'console.log("Hello!")');
   * const result = await sandbox.run();
   * console.log(result.logs); // ['Hello!']
   *
   * // Main function style - gets context
   * sandbox.writeFile('/index.ts', `
   *   export function main(ctx) {
   *     ctx.log("Args:", ctx.args);
   *     return { success: true };
   *   }
   * `);
   * const result = await sandbox.run({
   *   context: { args: ['--verbose'] }
   * });
   * console.log(result.returnValue); // { success: true }
   * ```
   */
  run(options?: RunOptions): Promise<RunResult>;
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

  /**
   * Dispose of resources held by this Sandlot instance.
   * 
   * This should be called when you're done using Sandlot to allow
   * the process to exit cleanly. It stops any background services
   * like the esbuild child process.
   * 
   * After calling dispose(), this instance should not be used.
   * 
   * @example
   * ```ts
   * const sandlot = await createNodeSandlot();
   * const sandbox = await sandlot.createSandbox();
   * 
   * // ... do work ...
   * 
   * await sandlot.dispose(); // Allow process to exit
   * ```
   */
  dispose(): Promise<void>;
}
