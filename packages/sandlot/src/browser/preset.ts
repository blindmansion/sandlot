import { createSandlot } from "../core/sandlot";
import {
  EsmTypesResolver,
  type EsmTypesResolverOptions,
} from "../core/esm-types-resolver";
import type { Sandlot, SandlotOptions } from "../types";
import { EsbuildWasmBundler, type EsbuildWasmBundlerOptions } from "./bundler";
import {
  Typechecker,
  type TypecheckerOptions,
} from "../core/typechecker";
import {
  MainThreadExecutor,
  type MainThreadExecutorOptions,
} from "./main-thread-executor";
import {
  IframeExecutor,
  type IframeExecutorOptions,
} from "./iframe-executor";

export interface CreateBrowserSandlotOptions
  extends Omit<SandlotOptions, "bundler" | "typechecker" | "typesResolver" | "executor"> {
  /**
   * Custom bundler options, or a pre-configured bundler instance.
   */
  bundler?: EsbuildWasmBundlerOptions | SandlotOptions["bundler"];

  /**
   * Custom typechecker options, or a pre-configured typechecker instance.
   * Set to `false` to disable type checking.
   */
  typechecker?:
  | TypecheckerOptions
  | SandlotOptions["typechecker"]
  | false;

  /**
   * Custom types resolver options, or a pre-configured resolver instance.
   * Set to `false` to disable type resolution.
   */
  typesResolver?:
  | EsmTypesResolverOptions
  | SandlotOptions["typesResolver"]
  | false;

  /**
   * Custom executor options, or a pre-configured executor instance.
   * Set to `false` to disable execution (sandbox.run() will throw).
   * Set to `"iframe"` to use IframeExecutor with default options.
   * Defaults to MainThreadExecutor.
   *
   * Note: IframeExecutor does NOT support shared modules. Use MainThreadExecutor
   * (the default) if you need shared modules like React.
   */
  executor?:
  | MainThreadExecutorOptions
  | IframeExecutorOptions
  | SandlotOptions["executor"]
  | "iframe"
  | false;
}

/**
 * Create a Sandlot instance pre-configured for browser environments.
 *
 * This is a convenience function that sets up sensible defaults:
 * - EsbuildWasmBundler for bundling
 * - Typechecker for type checking
 * - FetchTypesResolver for npm type resolution
 *
 * @example Basic usage
 * ```ts
 * const sandlot = await createBrowserSandlot();
 * const sandbox = await sandlot.createSandbox();
 * ```
 *
 * @example With shared modules
 * ```ts
 * import React from "react";
 * import ReactDOM from "react-dom/client";
 *
 * const sandlot = await createBrowserSandlot({
 *   sharedModules: {
 *     react: React,
 *     "react-dom/client": ReactDOM,
 *   },
 * });
 * ```
 *
 * @example Disable type checking for faster builds
 * ```ts
 * const sandlot = await createBrowserSandlot({
 *   typechecker: false,
 * });
 * ```
 */
export async function createBrowserSandlot(
  options: CreateBrowserSandlotOptions = {}
): Promise<Sandlot> {
  const { bundler, typechecker, typesResolver, executor, ...rest } = options;

  // Create or use provided bundler
  const bundlerInstance = isBundler(bundler)
    ? bundler
    : new EsbuildWasmBundler(bundler as EsbuildWasmBundlerOptions | undefined);

  // Initialize bundler (loads WASM)
  await bundlerInstance.initialize();

  // Create or use provided typechecker
  const typecheckerInstance =
    typechecker === false
      ? undefined
      : isTypechecker(typechecker)
        ? typechecker
        : new Typechecker(
          typechecker as TypecheckerOptions | undefined
        );

  // Create or use provided types resolver
  const typesResolverInstance =
    typesResolver === false
      ? undefined
      : isTypesResolver(typesResolver)
        ? typesResolver
        : new EsmTypesResolver(
          typesResolver as EsmTypesResolverOptions | undefined
        );

  // Create or use provided executor (defaults to MainThreadExecutor)
  const executorInstance =
    executor === false
      ? undefined
      : executor === "iframe"
        ? new IframeExecutor()
        : isExecutor(executor)
          ? executor
          : isIframeExecutorOptions(executor)
            ? new IframeExecutor(executor)
            : new MainThreadExecutor(
              executor as MainThreadExecutorOptions | undefined
            );

  return createSandlot({
    ...rest,
    bundler: bundlerInstance,
    typechecker: typecheckerInstance,
    typesResolver: typesResolverInstance,
    executor: executorInstance,
  });
}

// Type guards for detecting pre-configured instances

function isBundler(
  value: unknown
): value is SandlotOptions["bundler"] & { initialize(): Promise<void> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "bundle" in value &&
    typeof (value as { bundle: unknown }).bundle === "function"
  );
}

function isTypechecker(value: unknown): value is SandlotOptions["typechecker"] {
  return (
    typeof value === "object" &&
    value !== null &&
    "typecheck" in value &&
    typeof (value as { typecheck: unknown }).typecheck === "function"
  );
}

function isTypesResolver(
  value: unknown
): value is SandlotOptions["typesResolver"] {
  return (
    typeof value === "object" &&
    value !== null &&
    "resolveTypes" in value &&
    typeof (value as { resolveTypes: unknown }).resolveTypes === "function"
  );
}

function isExecutor(value: unknown): value is SandlotOptions["executor"] {
  return (
    typeof value === "object" &&
    value !== null &&
    "execute" in value &&
    typeof (value as { execute: unknown }).execute === "function"
  );
}

function isIframeExecutorOptions(value: unknown): value is IframeExecutorOptions {
  // IframeExecutorOptions has "sandbox" or "container" properties
  // MainThreadExecutorOptions only has "defaultTimeout"
  return (
    typeof value === "object" &&
    value !== null &&
    ("sandbox" in value || "container" in value)
  );
}
