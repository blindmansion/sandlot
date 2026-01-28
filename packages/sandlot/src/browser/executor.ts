/**
 * Main thread executor for browser environments.
 *
 * This executor runs code directly in the main thread. It provides no
 * isolation from the host environment - use only for trusted code.
 *
 * For untrusted code, consider using a Worker or iframe-based executor
 * that provides proper sandboxing.
 */

import type { IExecutor } from "../types";
import { createBasicExecutor, type BasicExecutorOptions } from "../core/executor";

/**
 * Options for creating a MainThreadExecutor.
 */
export type MainThreadExecutorOptions = BasicExecutorOptions;

/**
 * Load a module from code using a Blob URL.
 * The URL is revoked after import to avoid memory leaks.
 */
async function loadModuleFromBlobUrl(code: string): Promise<Record<string, unknown>> {
  const blob = new Blob([code], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Executor that runs code in the main browser thread.
 *
 * WARNING: This executor provides NO isolation. The executed code has
 * full access to the page's DOM, global variables, and network.
 * Only use for trusted code (e.g., code you're developing).
 *
 * @example
 * ```ts
 * const executor = createMainThreadExecutor();
 * const result = await executor.execute(bundledCode, {
 *   entryExport: 'main',
 *   context: { args: ['--verbose'] },
 *   timeout: 5000,
 * });
 * console.log(result.logs);
 * ```
 */
export class MainThreadExecutor implements IExecutor {
  private executor: IExecutor;

  constructor(options: MainThreadExecutorOptions = {}) {
    this.executor = createBasicExecutor(loadModuleFromBlobUrl, options);
  }

  execute: IExecutor["execute"] = (...args) => this.executor.execute(...args);
}

/**
 * Create a main thread executor.
 *
 * @param options - Executor options
 * @returns A new MainThreadExecutor instance
 */
export function createMainThreadExecutor(
  options?: MainThreadExecutorOptions
): MainThreadExecutor {
  return new MainThreadExecutor(options);
}
