// =============================================================================
// Sandlot v2 - Browser Entry Point
// =============================================================================
//
// Browser-specific implementations for Sandlot.
// Uses esbuild-wasm for bundling.
//
// Note: EsmTypesResolver is platform-independent and exported from the main
// "sandlot" entry point, not from "sandlot/browser".
//
// =============================================================================

// -----------------------------------------------------------------------------
// Bundler (browser-specific: uses esbuild-wasm)
// -----------------------------------------------------------------------------

export { EsbuildWasmBundler } from "./bundler";
export type { EsbuildWasmBundlerOptions } from "./bundler";

// -----------------------------------------------------------------------------
// Typechecker (browser-specific: fetches TS libs from CDN)
// -----------------------------------------------------------------------------

export { BrowserTypechecker } from "./typechecker";
export type { BrowserTypecheckerOptions } from "./typechecker";

// -----------------------------------------------------------------------------
// Executor (browser-specific: runs in main thread)
// -----------------------------------------------------------------------------

export { MainThreadExecutor, createMainThreadExecutor } from "./executor";
export type { MainThreadExecutorOptions } from "./executor";

// -----------------------------------------------------------------------------
// Convenience Preset
// -----------------------------------------------------------------------------

export { createBrowserSandlot } from "./preset";
export type { CreateBrowserSandlotOptions } from "./preset";
