// =============================================================================
// Sandlot v2 - Core Entry Point
// =============================================================================
//
// This module exports the core interfaces and factory function.
// It is context-agnostic - no browser or Node.js specific code.
//
// For context-specific implementations, import from:
//   - "sandlot/browser" - Browser implementations (esbuild-wasm, etc.)
//   - "sandlot/node"    - Node/Bun implementations (native esbuild, etc.)
//
// =============================================================================

// -----------------------------------------------------------------------------
// Factory Function
// -----------------------------------------------------------------------------

export { createSandlot } from "./core/sandlot";

// -----------------------------------------------------------------------------
// Filesystem
// -----------------------------------------------------------------------------

export {
  Filesystem,
  createFilesystem,
  wrapFilesystemForJustBash,
} from "./core/fs";
export type { FilesystemOptions } from "./core/fs";

// -----------------------------------------------------------------------------
// Shared Module Registry
// -----------------------------------------------------------------------------

export {
  SharedModuleRegistry,
  createSharedModuleRegistry,
} from "./core/shared-module-registry";

// -----------------------------------------------------------------------------
// Commands (for extending the shell with custom commands)
// -----------------------------------------------------------------------------

export {
  createSandlotCommand,
  createDefaultCommands,
  formatSize,
  formatDiagnostics,
  formatBundleErrors,
} from "./commands";
export type { SandboxRef } from "./commands";

// -----------------------------------------------------------------------------
// Typechecker (platform-independent, fetches TS libs from CDN)
// -----------------------------------------------------------------------------

export { Typechecker, createTypechecker } from "./core/typechecker";
export type { TypecheckerOptions } from "./core/typechecker";

// -----------------------------------------------------------------------------
// Types Resolver (platform-independent, works anywhere with fetch)
// -----------------------------------------------------------------------------

export {
  EsmTypesResolver,
  InMemoryTypesCache,
} from "./core/esm-types-resolver";
export type {
  EsmTypesResolverOptions,
  ResolvedTypes,
  ITypesCache,
} from "./core/esm-types-resolver";

// -----------------------------------------------------------------------------
// Types - Interfaces
// -----------------------------------------------------------------------------

export type {
  // Core interfaces (for implementing your own)
  IBundler,
  ITypechecker,
  ITypesResolver,
  ISharedModuleRegistry,
  IExecutor,

  // Main API types
  Sandlot,
  SandlotOptions,
  Sandbox,
  SandboxOptions,
  SandboxState,

  // Build types
  BuildPhase,
  BuildResult,
  BuildSuccess,
  BuildFailure,
  SandboxBuildOptions,

  // Install/Uninstall types
  InstallResult,
  UninstallResult,

  // Typecheck types
  SandboxTypecheckOptions,

  // Run types
  RunOptions,
  RunResult,

  // Executor types
  ExecuteOptions,
  ExecuteResult,

  // Bundler types
  BundleOptions,
  BundleResult,
  BundleSuccess,
  BundleFailure,
  BundleWarning,
  BundleError,
  BundleLocation,

  // Typechecker types
  TypecheckOptions,
  TypecheckResult,
  Diagnostic,

  // Shell execution types
  ExecResult,

  // Filesystem types
  IFileSystem,
  FsEntry,
  FsStat,
} from "./types";
