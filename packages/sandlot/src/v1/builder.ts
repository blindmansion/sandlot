/**
 * High-level builder for sandbox-based agent workflows.
 *
 * Provides a simple API that handles sandbox creation, build result capture,
 * validation, and timeout/cancellation—letting the caller focus on their agent logic.
 */

import { createSandbox, type Sandbox, type SandboxOptions } from "./sandbox";
import type { BundleResult } from "./bundler";
import type { BuildOutput } from "./commands/types";

/**
 * Result of running a builder.
 *
 * @typeParam T - The return type of the build function
 * @typeParam M - The type of the validated module (defaults to Record<string, unknown>)
 */
export interface BuildResult<T, M = Record<string, unknown>> {
  /**
   * Whatever the `build` function returned, or `undefined` if it threw.
   */
  result: T | undefined;

  /**
   * The error thrown by the `build` function, or `null` if it succeeded.
   *
   * When an error occurs, the bundle and module may still be available
   * if a build succeeded before the error was thrown.
   */
  error: Error | null;

  /**
   * The last successful build result, or null if no build succeeded.
   *
   * This captures the bundle from any successful `build` command executed
   * during the run. If multiple builds succeed, this contains the last one.
   *
   * **Important**: This is available even if the `build` function threw an error,
   * as long as a build succeeded before the error occurred.
   */
  bundle: BundleResult | null;

  /**
   * The loaded module exports, or null if no bundle was produced.
   *
   * When a build succeeds, the bundle is automatically loaded. If a `validate`
   * function was provided, the module is passed through it and the result is
   * available here with the validated type.
   *
   * @example Without validation
   * ```ts
   * const result = await runAgent("Create a counter");
   * result.module // Record<string, unknown> | null
   * ```
   *
   * @example With validation
   * ```ts
   * const result = await runAgent("Create a counter", {
   *   validate: (mod) => ({ App: mod.App as React.ComponentType }),
   * });
   * result.module // { App: React.ComponentType } | null
   * ```
   */
  module: M | null;

  /**
   * The sandbox that was used.
   *
   * Useful when the builder created an ephemeral sandbox—you can inspect
   * its state, save it, or reuse it for another build.
   */
  sandbox: Sandbox;
}

/**
 * Options passed when calling the builder function.
 *
 * @typeParam M - The type returned by the validate function (if provided)
 */
export interface BuildCallOptions<M = Record<string, unknown>> {
  /**
   * Validation function for the built module.
   *
   * When provided, this function runs as part of the build command—after
   * bundling and loading, but before the build is considered successful.
   * If validation throws, the build fails and the agent sees the error,
   * giving it a chance to fix the code and try again.
   *
   * The return type determines the type of `result.module`.
   *
   * @example Simple validation
   * ```ts
   * const result = await runAgent("Create a counter", {
   *   validate: (mod) => {
   *     if (typeof mod.App !== 'function') {
   *       throw new Error("Module must export an App component");
   *     }
   *     return { App: mod.App as React.ComponentType };
   *   },
   * });
   * // If validation fails, agent sees: "Build failed: Validation error."
   * // Agent can fix the code and try again
   * result.module?.App // React.ComponentType (after successful build)
   * ```
   *
   * @example With Zod
   * ```ts
   * import { z } from 'zod';
   *
   * const CounterSchema = z.object({
   *   App: z.custom<React.ComponentType>((v) => typeof v === 'function'),
   *   initialCount: z.number().optional(),
   * });
   *
   * const result = await runAgent("Create a counter", {
   *   validate: (mod) => CounterSchema.parse(mod),
   * });
   * result.module?.App          // React.ComponentType
   * result.module?.initialCount // number | undefined
   * ```
   */
  validate?: (module: Record<string, unknown>) => M;

  /**
   * Maximum time in milliseconds for the build to complete.
   *
   * If the timeout is exceeded, the build is aborted and an error is thrown.
   * The agent's partial work may still be available in the sandbox.
   *
   * @example
   * ```ts
   * const result = await runAgent("Create a complex dashboard", {
   *   timeout: 300_000, // 5 minutes
   * });
   * ```
   */
  timeout?: number;

  /**
   * AbortSignal for cancelling the build.
   *
   * If the signal is aborted, the build stops and an error is thrown.
   * Useful for user-initiated cancellation or external timeout management.
   *
   * @example
   * ```ts
   * const controller = new AbortController();
   *
   * // Start the build
   * const promise = runAgent("Create a counter", {
   *   signal: controller.signal,
   * });
   *
   * // Cancel after 10 seconds
   * setTimeout(() => controller.abort(), 10_000);
   *
   * try {
   *   const result = await promise;
   * } catch (err) {
   *   if (err.name === 'AbortError') {
   *     console.log('Build was cancelled');
   *   }
   * }
   * ```
   */
  signal?: AbortSignal;
}

/**
 * Options for creating a reusable builder function.
 */
export interface CreateBuilderOptions<T> {
  /**
   * Existing sandbox to reuse across all calls.
   *
   * When provided, the same sandbox is used for every call to the returned
   * builder function. Files and state persist between runs—useful for
   * iterative workflows where you want to build on previous work.
   *
   * @example
   * ```ts
   * const sandbox = await createSandbox({
   *   initialFiles: { '/src/utils.ts': 'export const PI = 3.14;' },
   * });
   *
   * const runAgent = createBuilder({
   *   sandbox, // Reused across all calls
   *   build: async (sb, prompt) => myAgent.run(sb, prompt),
   * });
   *
   * await runAgent("Create a circle component"); // Uses existing utils.ts
   * await runAgent("Add a square component");    // Still has circle + utils
   * ```
   */
  sandbox?: Sandbox;

  /**
   * Options for creating fresh sandboxes (only used if `sandbox` is not provided).
   *
   * Each call to the returned builder function creates a new sandbox with
   * these options. Use this when you want isolated runs.
   *
   * @example
   * ```ts
   * const runAgent = createBuilder({
   *   sandboxOptions: {
   *     sharedModules: ['react', 'react-dom/client'],
   *   },
   *   build: async (sandbox, prompt) => myAgent.run(sandbox, prompt),
   * });
   *
   * // Each call gets a fresh sandbox
   * await runAgent("Create a counter");  // Fresh sandbox
   * await runAgent("Create a todo list"); // Another fresh sandbox
   * ```
   */
  sandboxOptions?: SandboxOptions;

  /**
   * The function to build with the sandbox and prompt.
   *
   * This receives the sandbox and the prompt string, and should return
   * whatever result your agent produces.
   *
   * @example
   * ```ts
   * const runAgent = createBuilder({
   *   build: async (sandbox, prompt) => {
   *     const agent = new MyAgent({
   *       tools: { bash: sandbox.bash.exec },
   *     });
   *     return agent.run(prompt);
   *   },
   * });
   * ```
   */
  build: (sandbox: Sandbox, prompt: string) => Promise<T>;
}

/**
 * The builder function returned by `createBuilder`.
 *
 * Can be called with just a prompt, or with options including validation,
 * timeout, and abort signal.
 */
export interface BuilderFn<T> {
  /**
   * Run the builder with a prompt (no options).
   * Module will be typed as `Record<string, unknown>`.
   */
  (prompt: string): Promise<BuildResult<T>>;

  /**
   * Run the builder with a prompt and options.
   * If `validate` is provided, module will be typed based on its return type.
   */
  <M = Record<string, unknown>>(prompt: string, options: BuildCallOptions<M>): Promise<BuildResult<T, M>>;
}

/**
 * Create a reusable builder function for running prompts in a sandbox.
 *
 * This is the main API for sandlot. Define your agent logic once, then call
 * the returned function with different prompts. Each call:
 *
 * 1. Creates a sandbox (or uses one you provide)
 * 2. Sets up build result capture
 * 3. Runs your build function with the prompt
 * 4. Returns everything: your result, the bundle, the module, and the sandbox
 *
 * **Sandbox behavior:**
 * - If you provide `sandbox`: The same sandbox is reused for every call
 *   (files persist, good for iteration)
 * - If you provide `sandboxOptions` (or nothing): A fresh sandbox is created
 *   for each call (isolated runs)
 *
 * **Validation behavior:**
 * When you provide a `validate` function, it runs as part of the build command.
 * If validation fails, the build fails and the agent sees the error—giving it
 * a chance to fix the code and try again. This is more powerful than post-hoc
 * validation because the agent can iterate on validation errors.
 *
 * @example Basic usage
 * ```ts
 * import { createBuilder } from 'sandlot';
 *
 * const runAgent = createBuilder({
 *   sandboxOptions: { sharedModules: ['react', 'react-dom/client'] },
 *   build: async (sandbox, prompt) => {
 *     const agent = new MyAgent({ tools: { bash: sandbox.bash.exec } });
 *     return agent.run(prompt);
 *   },
 * });
 *
 * // Use it multiple times with different prompts
 * const result1 = await runAgent("Create a counter component");
 * const result2 = await runAgent("Create a todo list");
 *
 * if (result1.module?.App) {
 *   const Counter = result1.module.App as React.ComponentType;
 * }
 * ```
 *
 * @example With validation (agent can fix validation errors)
 * ```ts
 * const runAgent = createBuilder({
 *   sandboxOptions: { sharedModules: ['react'] },
 *   build: async (sandbox, prompt) => myAgent.run(sandbox, prompt),
 * });
 *
 * // Validation runs during build - agent sees errors and can fix them
 * const counter = await runAgent("Create a counter", {
 *   validate: (mod) => {
 *     if (typeof mod.App !== 'function') {
 *       throw new Error("Must export an App component");
 *     }
 *     return { App: mod.App as React.ComponentType };
 *   },
 * });
 * // If agent's first attempt fails validation, it sees:
 * // "Build failed: Validation error. Must export an App component"
 * // Agent can then fix the code and run build again
 * ```
 *
 * @example With Zod validation
 * ```ts
 * import { z } from 'zod';
 *
 * const CounterSchema = z.object({
 *   App: z.custom<React.ComponentType>((v) => typeof v === 'function'),
 *   initialCount: z.number().default(0),
 * });
 *
 * const result = await runAgent("Create a counter", {
 *   validate: (mod) => CounterSchema.parse(mod),
 * });
 * // result.module is fully typed from Zod inference
 * ```
 *
 * @example Iterative workflow with shared sandbox
 * ```ts
 * const sandbox = await createSandbox();
 *
 * const runAgent = createBuilder({
 *   sandbox, // Same sandbox for all calls
 *   build: async (sb, prompt) => myAgent.run(sb, prompt),
 * });
 *
 * // First prompt creates initial component
 * await runAgent("Create a button component");
 *
 * // Second prompt can build on the first
 * await runAgent("Add a click counter to the button");
 * ```
 *
 * @example With timeout
 * ```ts
 * // Complex tasks get more time
 * const result = await runAgent("Create a full dashboard with charts", {
 *   timeout: 300_000, // 5 minutes
 * });
 * ```
 *
 * @example With abort signal for cancellation
 * ```ts
 * const controller = new AbortController();
 *
 * // Start the build
 * const promise = runAgent("Create a counter", {
 *   signal: controller.signal,
 * });
 *
 * // User clicks cancel button
 * cancelButton.onclick = () => controller.abort();
 *
 * try {
 *   const result = await promise;
 * } catch (err) {
 *   if (err.name === 'AbortError') {
 *     console.log('Build was cancelled by user');
 *   }
 * }
 * ```
 */
export function createBuilder<T>(options: CreateBuilderOptions<T>): BuilderFn<T> {
  // Implementation handles both overloads
  return (async <M>(
    prompt: string,
    callOptions?: BuildCallOptions<M>
  ): Promise<BuildResult<T, M>> => {
    // Reuse provided sandbox, or create fresh each call
    const sandbox =
      options.sandbox ?? (await createSandbox(options.sandboxOptions));

    // Set validation function on sandbox before running agent
    // This makes validation part of the build command
    if (callOptions?.validate) {
      sandbox.setValidation(callOptions.validate as (mod: Record<string, unknown>) => Record<string, unknown>);
    }

    // Set up build capture - module is loaded during build command
    // Use object wrapper to avoid TypeScript narrowing issues with callbacks
    const captured: { output: BuildOutput | null } = { output: null };
    const unsubscribe = sandbox.onBuild((output) => {
      captured.output = output;
    });

    // Set up abort handling
    const { timeout, signal } = callOptions ?? {};
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortController: AbortController | undefined;

    // Create a combined abort signal if timeout or signal is provided
    if (timeout !== undefined || signal !== undefined) {
      abortController = new AbortController();

      // Set up timeout
      if (timeout !== undefined) {
        timeoutId = setTimeout(() => {
          abortController!.abort(new Error(`Build timed out after ${timeout}ms`));
        }, timeout);
      }

      // Forward external signal to our controller
      if (signal !== undefined) {
        if (signal.aborted) {
          abortController.abort(signal.reason);
        } else {
          signal.addEventListener("abort", () => {
            abortController!.abort(signal.reason);
          }, { once: true });
        }
      }
    }

    let result: T | undefined;
    let error: Error | null = null;

    try {
      // Create the build promise
      const buildPromise = options.build(sandbox, prompt);

      // If we have an abort controller, race against it
      if (abortController) {
        const abortPromise = new Promise<never>((_, reject) => {
          abortController!.signal.addEventListener("abort", () => {
            const err = abortController!.signal.reason instanceof Error
              ? abortController!.signal.reason
              : new Error("Build aborted");
            err.name = "AbortError";
            reject(err);
          }, { once: true });

          // If already aborted, reject immediately
          if (abortController!.signal.aborted) {
            const err = abortController!.signal.reason instanceof Error
              ? abortController!.signal.reason
              : new Error("Build aborted");
            err.name = "AbortError";
            reject(err);
          }
        });

        result = await Promise.race([buildPromise, abortPromise]);
      } else {
        result = await buildPromise;
      }
    } catch (err) {
      // Capture the error but the module may still be available
      // if a build succeeded before the error was thrown
      error = err instanceof Error ? err : new Error(String(err));
    } finally {
      // Clean up timeout
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }

      // Always clean up the subscription
      unsubscribe();

      // Always clear validation after the run
      if (callOptions?.validate) {
        sandbox.clearValidation();
      }
    }

    // Extract the build output
    const buildOutput = captured.output;

    return {
      result,
      error,
      bundle: buildOutput?.bundle ?? null,
      module: (buildOutput?.module ?? null) as M | null,
      sandbox,
    };
  }) as BuilderFn<T>;
}
