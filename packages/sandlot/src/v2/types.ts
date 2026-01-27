import type { IFileSystem, FsEntry } from "just-bash/browser";

// =============================================================================
// Re-export filesystem types for convenience
// =============================================================================

export type { IFileSystem, FsEntry } from "just-bash/browser";

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
  fs: IFileSystem;
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

export interface BundleResult {
  code: string;
  warnings: BundleWarning[];
  includedFiles: string[];
}

export interface BundleWarning {
  text: string;
  location?: {
    file: string;
    line: number;
    column?: number;
  };
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
  fs: IFileSystem;
  entryPoint: string;
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
    tsconfigPath?: string;
  };
}

// =============================================================================
// Sandbox Types
// =============================================================================

export interface SandboxOptions {
  /**
   * Initial files to populate the filesystem with
   */
  initialFiles?: Record<string, string>;

  /**
   * Maximum filesystem size in bytes
   */
  maxFilesystemSize?: number;

  /**
   * Path to tsconfig.json in the virtual filesystem
   */
  tsconfigPath?: string;

  /**
   * Callback invoked when a build succeeds
   */
  onBuild?: (result: BuildOutput) => void | Promise<void>;
}

export interface BuildOutput {
  bundle: BundleResult;
  module: Record<string, unknown>;
}

export interface Sandbox {
  /**
   * The virtual filesystem
   */
  readonly fs: IFileSystem;

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
