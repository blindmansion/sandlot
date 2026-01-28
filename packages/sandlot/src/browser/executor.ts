/**
 * Main thread executor for browser environments.
 *
 * This executor runs code directly in the main thread. It provides no
 * isolation from the host environment - use only for trusted code.
 *
 * For untrusted code, consider using a Worker or iframe-based executor
 * that provides proper sandboxing.
 */

import type { IExecutor, ExecuteOptions, ExecuteResult } from "../types";

/**
 * Options for creating a MainThreadExecutor.
 */
export interface MainThreadExecutorOptions {
  /**
   * Default timeout in milliseconds.
   * @default 30000
   */
  defaultTimeout?: number;
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
 * const executor = new MainThreadExecutor();
 * const result = await executor.execute(bundledCode, {
 *   entryExport: 'main',
 *   context: { args: ['--verbose'] },
 *   timeout: 5000,
 * });
 * console.log(result.logs);
 * ```
 */
export class MainThreadExecutor implements IExecutor {
  private defaultTimeout: number;

  constructor(options: MainThreadExecutorOptions = {}) {
    this.defaultTimeout = options.defaultTimeout ?? 30000;
  }

  async execute(code: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    const {
      entryExport = "main",
      context = {},
      timeout = this.defaultTimeout,
    } = options;

    const startTime = performance.now();
    const logs: string[] = [];

    // Capture console output
    const originalConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
      debug: console.debug,
    };

    const formatArgs = (...args: unknown[]) =>
      args
        .map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)))
        .join(" ");

    const captureLog = (...args: unknown[]) => {
      logs.push(formatArgs(...args));
      originalConsole.log.apply(console, args);
    };
    const captureWarn = (...args: unknown[]) => {
      logs.push(`[warn] ${formatArgs(...args)}`);
      originalConsole.warn.apply(console, args);
    };
    const captureError = (...args: unknown[]) => {
      logs.push(`[error] ${formatArgs(...args)}`);
      originalConsole.error.apply(console, args);
    };
    const captureInfo = (...args: unknown[]) => {
      logs.push(`[info] ${formatArgs(...args)}`);
      originalConsole.info.apply(console, args);
    };
    const captureDebug = (...args: unknown[]) => {
      logs.push(`[debug] ${formatArgs(...args)}`);
      originalConsole.debug.apply(console, args);
    };

    const restoreConsole = () => {
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      console.info = originalConsole.info;
      console.debug = originalConsole.debug;
    };

    // Install console interceptors
    console.log = captureLog;
    console.warn = captureWarn;
    console.error = captureError;
    console.info = captureInfo;
    console.debug = captureDebug;

    try {
      // Create blob URL and import the module
      const blob = new Blob([code], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);

      let module: Record<string, unknown>;
      try {
        // @vite-ignore prevents Vite from analyzing this dynamic import
        module = await import(/* @vite-ignore */ url);
      } finally {
        URL.revokeObjectURL(url);
      }

      // Execute the appropriate export
      let returnValue: unknown;

      const executeExport = async () => {
        if (entryExport === "main" && typeof module.main === "function") {
          // Call main(context)
          returnValue = await module.main(context);
        } else if (entryExport === "default" && typeof module.default === "function") {
          // Call default export (no args)
          returnValue = await module.default();
        } else if (entryExport === "default" && module.default !== undefined) {
          // Default export is a value, not a function
          returnValue = module.default;
        }
        // If neither export exists, top-level code already ran on import
      };

      // Execute with optional timeout
      if (timeout > 0) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`Execution timed out after ${timeout}ms`)),
            timeout
          );
        });
        await Promise.race([executeExport(), timeoutPromise]);
      } else {
        await executeExport();
      }

      const executionTimeMs = performance.now() - startTime;
      restoreConsole();

      return {
        success: true,
        logs,
        returnValue,
        executionTimeMs,
      };
    } catch (err) {
      const executionTimeMs = performance.now() - startTime;
      restoreConsole();

      return {
        success: false,
        logs,
        error: err instanceof Error ? err.message : String(err),
        executionTimeMs,
      };
    }
  }
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
