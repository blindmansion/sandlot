/**
 * Node/Bun/Deno bundler implementation using native esbuild.
 *
 * This is significantly faster than esbuild-wasm as it uses the native
 * esbuild binary instead of WebAssembly.
 */

import type * as EsbuildTypes from "esbuild";
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

export interface EsbuildNativeBundlerOptions {
  /**
   * Base URL for CDN imports.
   * npm imports like "lodash" are rewritten to "{cdnBaseUrl}/lodash@{version}".
   * @default "https://esm.sh"
   */
  cdnBaseUrl?: string;
}

/**
 * Bundler implementation using native esbuild.
 *
 * Uses the native esbuild binary for maximum performance.
 * Works with Node.js, Bun, and Deno.
 *
 * @example
 * ```ts
 * const bundler = new EsbuildNativeBundler();
 *
 * const result = await bundler.bundle({
 *   fs: myFilesystem,
 *   entryPoint: "/src/index.ts",
 * });
 * ```
 */
export class EsbuildNativeBundler implements IBundler {
  private options: EsbuildNativeBundlerOptions;
  private esbuild: typeof EsbuildTypes | null = null;

  constructor(options: EsbuildNativeBundlerOptions = {}) {
    this.options = {
      cdnBaseUrl: "https://esm.sh",
      ...options,
    };
  }

  /**
   * Initialize the bundler by loading native esbuild.
   * Called automatically on first bundle() if not already initialized.
   */
  async initialize(): Promise<void> {
    if (this.esbuild) {
      return;
    }

    // Dynamic import of native esbuild
    // This works in Node.js, Bun, and Deno
    this.esbuild = await import("esbuild");
  }

  private getEsbuild(): typeof EsbuildTypes {
    if (!this.esbuild) {
      throw new Error("esbuild not initialized - call initialize() first");
    }
    return this.esbuild;
  }

  /**
   * Dispose of the esbuild service.
   * This stops the esbuild child process and allows the Node.js process to exit.
   */
  async dispose(): Promise<void> {
    if (this.esbuild) {
      await this.esbuild.stop();
      this.esbuild = null;
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
    // resolve HTTP imports at runtime - native esbuild will fetch and bundle them
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
      // tells the VFS plugin to let native esbuild fetch and bundle CDN imports.
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
 * Create a native esbuild bundler.
 */
export function createEsbuildNativeBundler(
  options?: EsbuildNativeBundlerOptions
): EsbuildNativeBundler {
  return new EsbuildNativeBundler(options);
}
