// =============================================================================
// Sandlot v2 - Node/Bun/Deno Entry Point
// =============================================================================
//
// Server-side implementations for Sandlot.
// Uses native esbuild for bundling (much faster than esbuild-wasm).
//
// Note: The Typechecker and EsmTypesResolver are platform-independent and
// exported from the main "sandlot" entry point.
//
// =============================================================================

// -----------------------------------------------------------------------------
// Bundler (node-specific: uses native esbuild)
// -----------------------------------------------------------------------------

export { EsbuildNativeBundler, createEsbuildNativeBundler } from "./bundler";
export type { EsbuildNativeBundlerOptions } from "./bundler";

// -----------------------------------------------------------------------------
// WASM Bundler (for testing consistency with browser bundler)
// -----------------------------------------------------------------------------

export {
  EsbuildWasmNodeBundler,
  createEsbuildWasmNodeBundler,
} from "./wasm-bundler";
export type { EsbuildWasmNodeBundlerOptions } from "./wasm-bundler";

// -----------------------------------------------------------------------------
// Typechecker (platform-agnostic: re-exported for convenience)
// -----------------------------------------------------------------------------

export { Typechecker, createTypechecker } from "../core/typechecker";
export type { TypecheckerOptions } from "../core/typechecker";

// -----------------------------------------------------------------------------
// Executor (node-specific: uses data URLs)
// -----------------------------------------------------------------------------

export { NodeExecutor, createNodeExecutor } from "./executor";
export type { NodeExecutorOptions } from "./executor";

// -----------------------------------------------------------------------------
// Convenience Preset
// -----------------------------------------------------------------------------

export { createNodeSandlot } from "./preset";
export type { CreateNodeSandlotOptions } from "./preset";

// -----------------------------------------------------------------------------
// Re-exports
// -----------------------------------------------------------------------------

export type { Sandlot, Sandbox } from "../types";
