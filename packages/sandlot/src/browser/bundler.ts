/**
 * Browser bundler implementation using esbuild-wasm.
 *
 * This module handles WASM initialization and provides a bundler that
 * works entirely in the browser.
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

/**
 * esbuild-wasm version - should match what's in package.json
 */
const ESBUILD_VERSION = "0.27.2";

// =============================================================================
// Global Singleton for esbuild-wasm initialization
// =============================================================================
// esbuild-wasm can only be initialized once per page. We track this globally
// so multiple EsbuildWasmBundler instances can share the same initialization.

interface EsbuildGlobalState {
  esbuild: typeof EsbuildTypes | null;
  initialized: boolean;
  initPromise: Promise<void> | null;
}

const GLOBAL_KEY = "__sandlot_esbuild__";

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

export interface EsbuildWasmBundlerOptions {
  /**
   * URL to the esbuild WASM file.
   * @default "https://unpkg.com/esbuild-wasm@{version}/esbuild.wasm"
   */
  wasmUrl?: string;

  /**
   * URL to load esbuild-wasm module from.
   * @default "https://esm.sh/esbuild-wasm@{version}"
   */
  esbuildUrl?: string;

  /**
   * Base URL for CDN imports.
   * npm imports like "lodash" are rewritten to "{cdnBaseUrl}/lodash@{version}".
   * @default "https://esm.sh"
   */
  cdnBaseUrl?: string;

  /**
   * Whether to initialize immediately on construction.
   * If false, initialization happens lazily on first bundle() call.
   * @default false
   */
  eagerInit?: boolean;
}

/**
 * Browser bundler implementation using esbuild-wasm.
 *
 * Handles WASM initialization internally. The first bundle() call
 * will wait for initialization if not already complete.
 *
 * @example
 * ```ts
 * const bundler = new EsbuildWasmBundler();
 * await bundler.initialize();
 *
 * const result = await bundler.bundle({
 *   fs: myFilesystem,
 *   entryPoint: "/src/index.ts",
 * });
 * ```
 */
export class EsbuildWasmBundler implements IBundler {
  private options: EsbuildWasmBundlerOptions;

  constructor(options: EsbuildWasmBundlerOptions = {}) {
    this.options = {
      cdnBaseUrl: "https://esm.sh",
      ...options,
    };

    if (options.eagerInit) {
      this.initialize();
    }
  }

  /**
   * Initialize the esbuild WASM module.
   * Called automatically on first bundle() if not already initialized.
   *
   * Uses a global singleton pattern since esbuild-wasm can only be
   * initialized once per page.
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
    // Check for cross-origin isolation (needed for SharedArrayBuffer)
    this.checkCrossOriginIsolation();

    // Load esbuild-wasm from CDN
    const esbuildUrl =
      this.options.esbuildUrl ?? `https://esm.sh/esbuild-wasm@${ESBUILD_VERSION}`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* @vite-ignore */ esbuildUrl);
    const esbuild = mod.default ?? mod;

    if (typeof esbuild?.initialize !== "function") {
      throw new Error(
        "Failed to load esbuild-wasm: initialize function not found"
      );
    }

    // Initialize with WASM binary
    const wasmUrl =
      this.options.wasmUrl ??
      `https://unpkg.com/esbuild-wasm@${ESBUILD_VERSION}/esbuild.wasm`;

    await esbuild.initialize({ wasmURL: wasmUrl });

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

  private checkCrossOriginIsolation(): void {
    if (typeof window === "undefined") return;

    if (!window.crossOriginIsolated) {
      console.warn(
        "[sandlot] Cross-origin isolation is not enabled. " +
        "esbuild-wasm may have reduced performance or fail on some browsers.\n" +
        "To enable, add these headers to your server:\n" +
        "  Cross-Origin-Embedder-Policy: require-corp\n" +
        "  Cross-Origin-Opener-Policy: same-origin"
      );
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
    const plugin = createVfsPlugin({
      fs,
      entryPoint: normalizedEntry,
      installedPackages,
      sharedModules: new Set(sharedModules),
      sharedModuleRegistry: sharedModuleRegistry ?? null,
      cdnBaseUrl: this.options.cdnBaseUrl!,
      includedFiles,
    });

    try {
      // Run esbuild
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
