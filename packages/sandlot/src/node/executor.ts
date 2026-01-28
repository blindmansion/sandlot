/**
 * Node/Bun/Deno executor implementation.
 *
 * Executes bundled JavaScript code using temp files and dynamic import.
 * This provides basic execution without full isolation.
 *
 * For isolated execution, consider using Node's vm module or worker threads.
 */

import type { IExecutor } from "../types";
import { createBasicExecutor, type BasicExecutorOptions } from "../core/executor";
import { writeFileSync, unlinkSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Options for creating a NodeExecutor.
 */
export type NodeExecutorOptions = BasicExecutorOptions;

/**
 * Load a module from code using a temp file.
 * This works in Node.js, Bun, and Deno, and properly supports HTTP imports.
 */
async function loadModuleFromTempFile(code: string): Promise<Record<string, unknown>> {
  // Create a temp directory and file
  const tempDir = mkdtempSync(join(tmpdir(), "sandlot-"));
  const tempFile = join(tempDir, `module-${Date.now()}.mjs`);
  
  try {
    // Write the code to a temp file
    writeFileSync(tempFile, code, "utf-8");
    
    // Import from the temp file - this allows HTTP imports to work
    // Use file:// URL for cross-platform compatibility
    const fileUrl = `file://${tempFile}`;
    return await import(/* @vite-ignore */ fileUrl);
  } finally {
    // Clean up temp file
    try {
      unlinkSync(tempFile);
    } catch {
      // Ignore cleanup errors
    }
  }
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
 * const executor = createNodeExecutor();
 * const result = await executor.execute(bundledCode, {
 *   entryExport: 'main',
 *   context: { args: ['--verbose'] },
 *   timeout: 5000,
 * });
 * console.log(result.logs);
 * ```
 */
export class NodeExecutor implements IExecutor {
  private executor: IExecutor;

  constructor(options: NodeExecutorOptions = {}) {
    this.executor = createBasicExecutor(loadModuleFromTempFile, options);
  }

  execute: IExecutor["execute"] = (...args) => this.executor.execute(...args);
}

/**
 * Create a Node executor.
 *
 * @param options - Executor options
 * @returns A new NodeExecutor instance
 */
export function createNodeExecutor(options?: NodeExecutorOptions): NodeExecutor {
  return new NodeExecutor(options);
}
