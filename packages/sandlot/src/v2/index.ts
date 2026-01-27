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
// Shared Module Registry
// -----------------------------------------------------------------------------

export {
  SharedModuleRegistry,
  createSharedModuleRegistry,
} from "./core/shared-module-registry";

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

  BuildOutput,

  // Bundler types
  BundleOptions,
  BundleResult,
  BundleWarning,

  // Typechecker types
  TypecheckOptions,
  TypecheckResult,
  Diagnostic,

  // Execution types
  ExecResult,

  // Filesystem (re-exported from just-bash)
  IFileSystem,
  FsEntry,
} from "./types";
