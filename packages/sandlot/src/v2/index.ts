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

  // Main API types
  Sandlot,
  SandlotOptions,
  Sandbox,
  SandboxOptions,
  SandboxState,

  // Build types
  BuildResult,
  BuildSuccess,
  BuildFailure,
  SandboxBuildOptions,

  // Install/Uninstall types
  InstallResult,
  UninstallResult,

  // Typecheck types
  SandboxTypecheckOptions,

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

  // Execution types
  ExecResult,

  IFileSystem,
  FsEntry,
  FsStat,
} from "./types";
