import type {
  ITypechecker,
  TypecheckOptions,
  TypecheckResult,
} from "../types";

export interface BrowserTypecheckerOptions {
  /**
   * TypeScript lib files to include (e.g., "dom", "es2020").
   * If not provided, uses sensible browser defaults.
   */
  libs?: string[];

  /**
   * URL to fetch TypeScript lib files from.
   * Defaults to unpkg CDN.
   */
  libsBaseUrl?: string;
}

/**
 * Browser typechecker implementation using the TypeScript compiler API.
 *
 * Fetches TypeScript lib files from CDN and caches them in memory.
 *
 * @example
 * ```ts
 * const typechecker = new BrowserTypechecker();
 * const result = await typechecker.typecheck({
 *   fs: myFilesystem,
 *   entryPoint: "/src/index.ts",
 * });
 * ```
 */
export class BrowserTypechecker implements ITypechecker {
  private options: BrowserTypecheckerOptions;
  private libCache: Map<string, string> = new Map();
  private initPromise: Promise<void> | null = null;

  constructor(options: BrowserTypecheckerOptions = {}) {
    this.options = options;
  }

  /**
   * Pre-fetch TypeScript lib files.
   * Called automatically on first typecheck() if not already done.
   */
  async initialize(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.fetchLibs();
    await this.initPromise;
  }

  private async fetchLibs(): Promise<void> {
    // TODO: Fetch TypeScript lib files from CDN
    // const libs = this.options.libs ?? ["dom", "dom.iterable", "es2020"];
    // for (const lib of libs) { ... }
  }

  async typecheck(options: TypecheckOptions): Promise<TypecheckResult> {
    await this.initialize();

    // TODO: Implement type checking using TypeScript compiler API
    void options;

    throw new Error("BrowserTypechecker.typecheck() not yet implemented");
  }
}
