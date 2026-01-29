/**
 * Node/Bun/Deno bundler implementation using native esbuild.
 *
 * This is significantly faster than esbuild-wasm as it uses the native
 * esbuild binary instead of WebAssembly.
 */

import type * as EsbuildTypes from "esbuild";
import type { IBundler, BundleOptions, BundleResult } from "../types";
import { executeBundleWithEsbuild, type EsmUrlOptions } from "../core/bundler-utils";

export interface EsbuildNativeBundlerOptions {
  /**
   * Base URL for CDN imports.
   * npm imports like "lodash" are rewritten to "{cdnBaseUrl}/lodash@{version}".
   * @default "https://esm.sh"
   */
  cdnBaseUrl?: string;

  /**
   * ECMAScript target for esm.sh CDN imports.
   * 
   * This sets the `?target=` query parameter on esm.sh URLs to ensure
   * consistent output. Without this, esm.sh uses User-Agent detection
   * which can vary between environments.
   * 
   * @example "es2020"
   * @example "es2022"
   * @default "es2020"
   */
  esmTarget?: string;
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
      esmTarget: "es2020",
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

    // Build esm.sh URL options
    const esmOptions: EsmUrlOptions = {};
    if (this.options.esmTarget) {
      esmOptions.target = this.options.esmTarget;
    }

    // bundleCdnImports is true for Node/Bun because they cannot
    // resolve HTTP imports at runtime - native esbuild will fetch and bundle them
    return executeBundleWithEsbuild({
      esbuild: this.getEsbuild(),
      bundleOptions: options,
      cdnBaseUrl: this.options.cdnBaseUrl!,
      bundleCdnImports: true,
      esmOptions,
    });
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
