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
import type {
  IBundler,
  BundleOptions,
  BundleResult,
  BundleWarning,
  BundleError,
} from "../types";
import {
  createVfsPlugin,
  isEsbuildBuildFailure,
  convertEsbuildMessage,
} from "../core/bundler-utils";

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

    const esbuild = this.getEsbuild();

    const {
      fs,
      entryPoint,
      installedPackages = {},
      sharedModules = [],
      sharedModuleRegistry,
      external = [],
      format = "esm",
      minify = false,
      sourcemap = false,
      target = ["es2020"],
    } = options;

    // Normalize entry point to absolute path
    const normalizedEntry = entryPoint.startsWith("/")
      ? entryPoint
      : `/${entryPoint}`;

    // Verify entry point exists
    if (!fs.exists(normalizedEntry)) {
      return {
        success: false,
        errors: [{ text: `Entry point not found: ${normalizedEntry}` }],
        warnings: [],
      };
    }

    // Track files included in the bundle
    const includedFiles = new Set<string>();

    // Create the VFS plugin
    // Note: bundleCdnImports is true for Node/Bun because they cannot
    // resolve HTTP imports at runtime - esbuild will fetch and bundle them
    const plugin = createVfsPlugin({
      fs,
      entryPoint: normalizedEntry,
      installedPackages,
      sharedModules: new Set(sharedModules),
      sharedModuleRegistry: sharedModuleRegistry ?? null,
      cdnBaseUrl: this.options.cdnBaseUrl!,
      includedFiles,
      bundleCdnImports: true,
    });

    try {
      // Run esbuild
      // Note: We do NOT mark http/https as external here because Node/Bun
      // cannot resolve HTTP imports at runtime. Instead, bundleCdnImports: true
      // tells the VFS plugin to let esbuild fetch and bundle CDN imports.
      const result = await esbuild.build({
        entryPoints: [normalizedEntry],
        bundle: true,
        write: false,
        format,
        minify,
        sourcemap: sourcemap ? "inline" : false,
        target,
        external,
        // Cast to esbuild's Plugin type since our minimal interface is compatible
        plugins: [plugin as EsbuildTypes.Plugin],
        jsx: "automatic",
      });

      const code = result.outputFiles?.[0]?.text ?? "";

      // Convert esbuild warnings to our format
      const warnings: BundleWarning[] = result.warnings.map((w) =>
        convertEsbuildMessage(w)
      );

      return {
        success: true,
        code,
        warnings,
        includedFiles: Array.from(includedFiles),
      };
    } catch (err) {
      // esbuild throws BuildFailure with .errors array
      if (isEsbuildBuildFailure(err)) {
        const errors: BundleError[] = err.errors.map((e) =>
          convertEsbuildMessage(e)
        );
        const warnings: BundleWarning[] = err.warnings.map((w) =>
          convertEsbuildMessage(w)
        );
        return {
          success: false,
          errors,
          warnings,
        };
      }

      // Unknown error - wrap it
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        errors: [{ text: message }],
        warnings: [],
      };
    }
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
