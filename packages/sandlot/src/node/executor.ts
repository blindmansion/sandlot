/**
 * Node/Bun/Deno executor implementation.
 *
 * Executes bundled JavaScript code using data URLs and dynamic import.
 * This provides basic execution without full isolation.
 *
 * For isolated execution, consider using Node's vm module or worker threads.
 */

import type { IExecutor, ExecuteOptions, ExecuteResult } from "../types";

/**
 * Options for creating a NodeExecutor.
 */
export interface NodeExecutorOptions {
  /**
   * Default timeout in milliseconds.
   * @default 30000
   */
  defaultTimeout?: number;
}

/**
 * Executor that runs code in Node.js/Bun/Deno.
 *
 * Uses data URLs with dynamic import for execution.
 * This approach works across Node.js, Bun, and Deno.
 *
 * WARNING: This executor provides NO isolation. The executed code has
 * full access to the process environment, file system, and network.
 * Only use for trusted code.
 *
 * @example
 * ```ts
 * const executor = new NodeExecutor();
 * const result = await executor.execute(bundledCode, {
 *   entryExport: 'main',
 *   context: { args: ['--verbose'] },
 *   timeout: 5000,
 * });
 * console.log(result.logs);
 * ```
 */
export class NodeExecutor implements IExecutor {
  private defaultTimeout: number;

  constructor(options: NodeExecutorOptions = {}) {
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
      // Create data URL from the code
      // This works in Node.js 20+, Bun, and Deno
      const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

      let module: Record<string, unknown>;
      try {
        // Dynamic import from data URL
        module = await import(/* @vite-ignore */ dataUrl);
      } catch (importErr) {
        // If data URL import fails, try a different approach for older Node versions
        // This is a fallback that writes to a temp file
        throw importErr;
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
 * Create a Node executor.
 *
 * @param options - Executor options
 * @returns A new NodeExecutor instance
 */
export function createNodeExecutor(
  options?: NodeExecutorOptions
): NodeExecutor {
  return new NodeExecutor(options);
}
