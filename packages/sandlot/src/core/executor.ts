/**
 * Base executor implementation shared by browser and node executors.
 *
 * This module provides the core execution logic with console capture,
 * timeout handling, and export invocation. Platform-specific executors
 * only need to provide a function to load code as a module.
 */

import type { IExecutor, ExecuteOptions, ExecuteResult } from "../types";

/**
 * Function that loads JavaScript code as a module.
 * Platform-specific implementations convert code to an importable URL.
 */
export type ModuleLoader = (code: string) => Promise<Record<string, unknown>>;

/**
 * Options for creating a basic executor.
 */
export interface BasicExecutorOptions {
  /**
   * Default timeout in milliseconds.
   * @default 30000
   */
  defaultTimeout?: number;
}

/**
 * Create an executor using the provided module loader.
 *
 * This is the shared implementation used by both browser and node executors.
 * The only platform-specific part is how code is loaded as a module.
 *
 * @param loadModule - Function that loads code as a module
 * @param options - Executor options
 * @returns An executor instance
 */
export function createBasicExecutor(
  loadModule: ModuleLoader,
  options: BasicExecutorOptions = {}
): IExecutor {
  const defaultTimeout = options.defaultTimeout ?? 30000;

  return {
    async execute(code: string, execOptions: ExecuteOptions = {}): Promise<ExecuteResult> {
      const {
        entryExport = "main",
        context = {},
        timeout = defaultTimeout,
      } = execOptions;

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
      };
      const captureWarn = (...args: unknown[]) => {
        logs.push(`[warn] ${formatArgs(...args)}`);
      };
      const captureError = (...args: unknown[]) => {
        logs.push(`[error] ${formatArgs(...args)}`);
      };
      const captureInfo = (...args: unknown[]) => {
        logs.push(`[info] ${formatArgs(...args)}`);
      };
      const captureDebug = (...args: unknown[]) => {
        logs.push(`[debug] ${formatArgs(...args)}`);
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
        // Load the module using the platform-specific loader
        const module = await loadModule(code);

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
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error(`Execution timed out after ${timeout}ms`)),
              timeout
            );
          });
          try {
            await Promise.race([executeExport(), timeoutPromise]);
          } finally {
            // Clear the timeout to allow the process to exit
            if (timeoutId) clearTimeout(timeoutId);
          }
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
    },
  };
}
