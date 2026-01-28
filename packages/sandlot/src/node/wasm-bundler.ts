/**
 * Node/Bun/Deno bundler implementation using esbuild-wasm.
 *
 * This bundler uses the same WebAssembly-based esbuild as the browser bundler,
 * but runs in Node.js/Bun/Deno environments. It's primarily useful for:
 *
 * 1. Testing consistency with the browser bundler
 * 2. Ensuring identical import resolution behavior
 * 3. Validating that bundled output matches between browser and server
 *
 * For production use, prefer EsbuildNativeBundler which is ~3-5x faster.
 */

import type * as EsbuildTypes from "esbuild-wasm";
import type { IBundler, BundleOptions, BundleResult } from "../types";
import { executeBundleWithEsbuild } from "../core/bundler-utils";

// =============================================================================
// Global Singleton for esbuild-wasm initialization
// =============================================================================
// esbuild-wasm can only be initialized once per process. We track this globally
// so multiple EsbuildWasmNodeBundler instances can share the same initialization.

interface EsbuildGlobalState {
  esbuild: typeof EsbuildTypes | null;
  initialized: boolean;
  initPromise: Promise<void> | null;
}

// Use a different key than the browser bundler to avoid conflicts if both
// are somehow loaded in the same environment (e.g., during SSR)
const GLOBAL_KEY = "__sandlot_esbuild_wasm_node__";

function getGlobalState(): EsbuildGlobalState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      esbuild: null,
      initialized: false,
      initPromise: null,
    };
  }
  return g[GLOBAL_KEY];
}

export interface EsbuildWasmNodeBundlerOptions {
  /**
   * Base URL for CDN imports.
   * npm imports like "lodash" are rewritten to "{cdnBaseUrl}/lodash@{version}".
   * @default "https://esm.sh"
   */
  cdnBaseUrl?: string;
}

/**
 * Bundler implementation using esbuild-wasm for Node.js/Bun/Deno.
 *
 * Uses the same WebAssembly-based esbuild as the browser bundler,
 * making it ideal for testing consistency between browser and server builds.
 *
 * @example
 * ```ts
 * const bundler = new EsbuildWasmNodeBundler();
 * await bundler.initialize();
 *
 * const result = await bundler.bundle({
 *   fs: myFilesystem,
 *   entryPoint: "/src/index.ts",
 * });
 * ```
 *
 * @example Testing consistency with native bundler
 * ```ts
 * const native = new EsbuildNativeBundler();
 * const wasm = new EsbuildWasmNodeBundler();
 *
 * await native.initialize();
 * await wasm.initialize();
 *
 * const nativeResult = await native.bundle(options);
 * const wasmResult = await wasm.bundle(options);
 *
 * // Results should be equivalent (modulo minor formatting differences)
 * ```
 */
export class EsbuildWasmNodeBundler implements IBundler {
  private options: EsbuildWasmNodeBundlerOptions;

  constructor(options: EsbuildWasmNodeBundlerOptions = {}) {
    this.options = {
      cdnBaseUrl: "https://esm.sh",
      ...options,
    };
  }

  /**
   * Initialize the esbuild WASM module.
   * Called automatically on first bundle() if not already initialized.
   *
   * Uses a global singleton pattern since esbuild-wasm can only be
   * initialized once per process.
   */
  async initialize(): Promise<void> {
    const state = getGlobalState();

    // Already initialized globally
    if (state.initialized && state.esbuild) {
      return;
    }

    // Another instance is initializing - wait for it
    if (state.initPromise) {
      await state.initPromise;
      return;
    }

    // We're the first - do the initialization
    state.initPromise = this.doInitialize(state);
    await state.initPromise;
  }

  private async doInitialize(state: EsbuildGlobalState): Promise<void> {
    // Import esbuild-wasm from node_modules
    const esbuild = await import("esbuild-wasm");

    if (typeof esbuild?.initialize !== "function") {
      throw new Error(
        "Failed to load esbuild-wasm: initialize function not found"
      );
    }

    // In Node.js/Bun/Deno, esbuild-wasm automatically loads the WASM
    // from node_modules without needing a wasmURL option.
    // The wasmURL option is only for browsers.
    await esbuild.initialize({});

    // Store in global state
    state.esbuild = esbuild;
    state.initialized = true;
  }

  /**
   * Get the initialized esbuild instance.
   */
  private getEsbuild(): typeof EsbuildTypes {
    const state = getGlobalState();
    if (!state.esbuild) {
      throw new Error("esbuild not initialized - call initialize() first");
    }
    return state.esbuild;
  }

  /**
   * Dispose of the esbuild WASM service.
   * This stops the esbuild service and allows the process to exit.
   * 
   * Note: Since esbuild-wasm uses a global singleton, this affects all
   * instances. After dispose(), you'll need to create a new bundler.
   */
  async dispose(): Promise<void> {
    const state = getGlobalState();
    if (state.esbuild) {
      await state.esbuild.stop();
      state.esbuild = null;
      state.initialized = false;
      state.initPromise = null;
    }
  }

  async bundle(options: BundleOptions): Promise<BundleResult> {
    await this.initialize();

    // bundleCdnImports is true for Node/Bun because they cannot
    // resolve HTTP imports at runtime - esbuild will fetch and bundle them
    return executeBundleWithEsbuild({
      esbuild: this.getEsbuild(),
      bundleOptions: options,
      cdnBaseUrl: this.options.cdnBaseUrl!,
      bundleCdnImports: true,
    });
  }
}

/**
 * Create an esbuild-wasm bundler for Node.js/Bun/Deno.
 *
 * This is primarily useful for testing consistency with the browser bundler.
 * For production use, prefer createEsbuildNativeBundler() which is ~3-5x faster.
 */
export function createEsbuildWasmNodeBundler(
  options?: EsbuildWasmNodeBundlerOptions
): EsbuildWasmNodeBundler {
  return new EsbuildWasmNodeBundler(options);
}
