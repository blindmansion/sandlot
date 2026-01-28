import { createSandlot } from "../core/sandlot";
import {
  EsmTypesResolver,
  type EsmTypesResolverOptions,
} from "../core/esm-types-resolver";
import type { Sandlot, SandlotOptions } from "../types";
import { EsbuildNativeBundler, type EsbuildNativeBundlerOptions } from "./bundler";
import {
  EsbuildWasmNodeBundler,
  type EsbuildWasmNodeBundlerOptions,
} from "./wasm-bundler";
import {
  Typechecker,
  type TypecheckerOptions,
} from "../core/typechecker";
import {
  NodeExecutor,
  type NodeExecutorOptions,
} from "./executor";

export interface CreateNodeSandlotOptions
  extends Omit<SandlotOptions, "bundler" | "typechecker" | "typesResolver" | "executor"> {
  /**
   * Custom bundler options, or a pre-configured bundler instance.
   *
   * Set to `"wasm"` to use the WASM bundler (for testing consistency with browser).
   * You can also pass `{ wasm: true, ...options }` for WASM bundler with custom options.
   *
   * @default EsbuildNativeBundler (fastest, uses native esbuild binary)
   */
  bundler?:
    | EsbuildNativeBundlerOptions
    | (EsbuildWasmNodeBundlerOptions & { wasm: true })
    | SandlotOptions["bundler"]
    | "wasm";

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
   * Defaults to NodeExecutor.
   */
  executor?:
  | NodeExecutorOptions
  | SandlotOptions["executor"]
  | false;
}

/**
 * Create a Sandlot instance pre-configured for Node.js/Bun/Deno environments.
 *
 * This is a convenience function that sets up sensible defaults:
 * - EsbuildNativeBundler for bundling (uses native esbuild)
 * - Typechecker for type checking (fetches libs from CDN)
 * - EsmTypesResolver for npm type resolution
 * - NodeExecutor for code execution
 *
 * @example Basic usage
 * ```ts
 * const sandlot = await createNodeSandlot();
 * const sandbox = await sandlot.createSandbox();
 * ```
 *
 * @example With shared modules
 * ```ts
 * import express from "express";
 *
 * const sandlot = await createNodeSandlot({
 *   sharedModules: {
 *     express,
 *   },
 * });
 * ```
 *
 * @example Disable type checking for faster builds
 * ```ts
 * const sandlot = await createNodeSandlot({
 *   typechecker: false,
 * });
 * ```
 *
 * @example Use WASM bundler for testing consistency with browser
 * ```ts
 * const sandlot = await createNodeSandlot({
 *   bundler: "wasm",
 * });
 * ```
 */
export async function createNodeSandlot(
  options: CreateNodeSandlotOptions = {}
): Promise<Sandlot> {
  const { bundler, typechecker, typesResolver, executor, ...rest } = options;

  // Create or use provided bundler
  const bundlerInstance = createBundlerInstance(bundler);

  // Initialize bundler (loads native esbuild or WASM)
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

  // Create or use provided executor (defaults to NodeExecutor)
  const executorInstance =
    executor === false
      ? undefined
      : isExecutor(executor)
        ? executor
        : new NodeExecutor(
          executor as NodeExecutorOptions | undefined
        );

  return createSandlot({
    ...rest,
    bundler: bundlerInstance,
    typechecker: typecheckerInstance,
    typesResolver: typesResolverInstance,
    executor: executorInstance,
  });
}

// Helper to create bundler instance based on options

function createBundlerInstance(
  bundler: CreateNodeSandlotOptions["bundler"]
): (EsbuildNativeBundler | EsbuildWasmNodeBundler) & { initialize(): Promise<void> } {
  // Already a bundler instance
  if (isBundler(bundler)) {
    return bundler as (EsbuildNativeBundler | EsbuildWasmNodeBundler) & { initialize(): Promise<void> };
  }

  // String shorthand for WASM bundler
  if (bundler === "wasm") {
    return new EsbuildWasmNodeBundler();
  }

  // Object with wasm: true flag
  if (isWasmBundlerOptions(bundler)) {
    const { wasm: _, ...wasmOptions } = bundler;
    return new EsbuildWasmNodeBundler(wasmOptions);
  }

  // Default: native bundler (fastest)
  return new EsbuildNativeBundler(bundler as EsbuildNativeBundlerOptions | undefined);
}

function isWasmBundlerOptions(
  value: unknown
): value is EsbuildWasmNodeBundlerOptions & { wasm: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    "wasm" in value &&
    (value as { wasm: unknown }).wasm === true
  );
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
