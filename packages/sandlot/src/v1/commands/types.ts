/**
 * Types and utilities for sandbox bash commands.
 */

import type { IFileSystem } from "just-bash/browser";
import type { BundleResult } from "../bundler";
import type { TypesCache } from "../packages";

/**
 * The result of a successful build, including the bundle and loaded module.
 */
export interface BuildOutput {
  /**
   * The compiled bundle (code, metadata, etc.)
   */
  bundle: BundleResult;

  /**
   * The loaded module exports.
   * If validation was provided, this is the validated module.
   */
  module: Record<string, unknown>;
}

/**
 * Validation function type for module validation.
 * Takes the raw module exports and returns validated exports (or throws).
 */
export type ValidateFn = (module: Record<string, unknown>) => Record<string, unknown>;

/**
 * Dependencies required by command factories
 */
export interface CommandDeps {
  /**
   * The virtual filesystem to operate on
   */
  fs: IFileSystem;

  /**
   * Pre-loaded TypeScript lib files for type checking
   */
  libFiles: Map<string, string>;

  /**
   * Path to tsconfig.json in the virtual filesystem
   */
  tsconfigPath: string;

  /**
   * Callback invoked when a build succeeds (after loading and validation).
   */
  onBuild?: (result: BuildOutput) => void | Promise<void>;

  /**
   * Getter for the current validation function.
   * Called during build to check if validation should be performed.
   */
  getValidation?: () => ValidateFn | null;

  /**
   * Cache for package type definitions.
   * When provided, avoids redundant network fetches for packages
   * that have already been installed in other sandboxes.
   */
  typesCache?: TypesCache;

  /**
   * Options for the `run` command
   */
  runOptions?: RunOptions;

  /**
   * Module IDs that should be resolved from the host's SharedModuleRegistry
   * instead of esm.sh CDN. The host must have registered these modules.
   * 
   * Example: ['react', 'react-dom/client']
   */
  sharedModules?: string[];
}

/**
 * Runtime context passed to the `main()` function when code is executed.
 * This provides sandboxed code with access to sandbox capabilities.
 */
export interface RunContext {
  /**
   * The virtual filesystem - read/write files within the sandbox
   */
  fs: IFileSystem;

  /**
   * Environment variables (configurable per-sandbox)
   */
  env: Record<string, string>;

  /**
   * Command-line arguments passed to `run`
   */
  args: string[];

  /**
   * Explicit logging function (alternative to console.log)
   */
  log: (...args: unknown[]) => void;

  /**
   * Explicit error logging function (alternative to console.error)
   */
  error: (...args: unknown[]) => void;
}

/**
 * Options for configuring the `run` command behavior
 */
export interface RunOptions {
  /**
   * Environment variables available via ctx.env
   */
  env?: Record<string, string>;

  /**
   * Maximum execution time in milliseconds (default: 30000 = 30s)
   * Set to 0 to disable timeout.
   */
  timeout?: number;

  /**
   * Whether to skip type checking before running (default: false)
   */
  skipTypecheck?: boolean;
}

/**
 * Result of running code via the `run` command
 */
export interface RunResult {
  /**
   * Captured console output (log, warn, error)
   */
  logs: string[];

  /**
   * Return value from main() if present
   */
  returnValue?: unknown;

  /**
   * Execution time in milliseconds
   */
  executionTimeMs: number;
}

/**
 * Format esbuild messages (warnings/errors) for display
 */
export function formatEsbuildMessages(
  messages: { text: string; location?: { file?: string; line?: number; column?: number } | null }[]
): string {
  if (messages.length === 0) return "";

  return messages
    .map((msg) => {
      if (msg.location) {
        const { file, line, column } = msg.location;
        const loc = file ? `${file}${line ? `:${line}` : ""}${column ? `:${column}` : ""}` : "";
        return loc ? `${loc}: ${msg.text}` : msg.text;
      }
      return msg.text;
    })
    .join("\n");
}
