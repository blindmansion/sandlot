/**
 * Build event emitter for sandbox environments.
 *
 * Simple typed event emitter for successful build results.
 * Used internally by the sandbox to notify listeners when a build succeeds.
 */

import type { BuildOutput } from "./commands/types";

/**
 * Simple typed event emitter for build results.
 *
 * Only emits on successful builds—build failures are communicated via
 * the bash command's exit code and stderr.
 *
 * For most use cases, prefer using `createBuilder()` which handles
 * build result capture automatically.
 */
export class BuildEmitter {
  private listeners = new Set<(result: BuildOutput) => void | Promise<void>>();

  /**
   * Emit a build result to all listeners.
   * Called internally when a build command succeeds.
   */
  emit = async (result: BuildOutput): Promise<void> => {
    const promises: Promise<void>[] = [];
    for (const listener of this.listeners) {
      const ret = listener(result);
      if (ret instanceof Promise) {
        promises.push(ret);
      }
    }
    await Promise.all(promises);
  };

  /**
   * Subscribe to build events. Returns an unsubscribe function.
   *
   * The callback is invoked each time a build succeeds, receiving
   * the BuildOutput with the bundle and loaded module.
   *
   * @example
   * ```ts
   * let lastBuild: BuildOutput | null = null;
   * const unsubscribe = sandbox.onBuild((result) => {
   *   lastBuild = result;
   * });
   *
   * await sandbox.bash.exec('build /src/index.ts');
   * unsubscribe();
   *
   * if (lastBuild) {
   *   const App = lastBuild.module.App as React.ComponentType;
   * }
   * ```
   */
  on(callback: (result: BuildOutput) => void | Promise<void>): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }
}
