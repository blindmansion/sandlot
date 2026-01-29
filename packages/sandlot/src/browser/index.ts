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

// =============================================================================
// Browser Polyfills - inject before anything else loads
// =============================================================================
//
// Some dependencies (like just-bash) reference Node.js globals.
// Provide shims so they work in the browser without user configuration.
//
if (typeof window !== "undefined" && typeof globalThis.process === "undefined") {
  (globalThis as Record<string, unknown>).process = {
    env: {},
    platform: "browser",
    version: "v20.0.0",
    browser: true,
    cwd: () => "/",
    nextTick: (fn: () => void) => setTimeout(fn, 0),
  };
}

// -----------------------------------------------------------------------------
// Typechecker (platform-agnostic: re-exported for convenience)
// -----------------------------------------------------------------------------

export { Typechecker, createTypechecker } from "../core/typechecker";
export type { TypecheckerOptions } from "../core/typechecker";

// -----------------------------------------------------------------------------
// Bundler (browser-specific: uses esbuild-wasm)
// -----------------------------------------------------------------------------

export { EsbuildWasmBundler } from "./bundler";
export type { EsbuildWasmBundlerOptions } from "./bundler";

// -----------------------------------------------------------------------------
// Executor (browser-specific: runs in main thread)
// -----------------------------------------------------------------------------

export { MainThreadExecutor, createMainThreadExecutor } from "./main-thread-executor";
export type { MainThreadExecutorOptions } from "./main-thread-executor";

// -----------------------------------------------------------------------------
// Iframe Executor (browser-specific: runs in sandboxed iframe)
// -----------------------------------------------------------------------------

export { IframeExecutor, createIframeExecutor } from "./iframe-executor";
export type { IframeExecutorOptions } from "./iframe-executor";

// -----------------------------------------------------------------------------
// Persistor (browser-specific: IndexedDB-backed)
// -----------------------------------------------------------------------------

export { IndexedDBPersistor, createIndexedDBPersistor } from "./persistor";

// -----------------------------------------------------------------------------
// Convenience Preset
// -----------------------------------------------------------------------------

export { createBrowserSandlot } from "./preset";
export type { CreateBrowserSandlotOptions } from "./preset";
