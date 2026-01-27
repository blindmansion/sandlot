import type {
  Sandlot,
  SandlotOptions,
  SandboxOptions,
  Sandbox,
  ISharedModuleRegistry,
} from "../types";
import { createSharedModuleRegistry } from "./shared-module-registry";

/**
 * Create a new Sandlot instance with the provided implementations.
 *
 * This is the main factory function. You provide the bundler, typechecker,
 * and other implementations appropriate for your runtime context.
 *
 * @example Browser usage
 * ```ts
 * import { createSandlot } from "sandlot";
 * import { EsbuildWasmBundler } from "sandlot/browser";
 *
 * const sandlot = createSandlot({
 *   bundler: new EsbuildWasmBundler(),
 *   sharedModules: { react: React },
 * });
 * ```
 *
 * @example Node/Bun usage
 * ```ts
 * import { createSandlot } from "sandlot";
 * import { EsbuildNativeBundler } from "sandlot/node";
 *
 * const sandlot = createSandlot({
 *   bundler: new EsbuildNativeBundler(),
 * });
 * ```
 */
export function createSandlot(options: SandlotOptions): Sandlot {
  const {
    bundler,
    typechecker,
    typesResolver,
    sharedModules,
    sandboxDefaults = {},
  } = options;

  // Create shared module registry if modules were provided
  const sharedModuleRegistry = createSharedModuleRegistry(sharedModules);

  return {
    async createSandbox(sandboxOptions?: SandboxOptions): Promise<Sandbox> {
      // TODO: Implement using sandbox logic
      // Will use: bundler, typechecker, typesResolver, sharedModuleRegistry, sandboxDefaults
      void sandboxOptions;
      void bundler;
      void typechecker;
      void typesResolver;
      void sandboxDefaults;
      throw new Error("createSandbox not yet implemented");
    },

    get sharedModules(): ISharedModuleRegistry | null {
      return sharedModuleRegistry;
    },
  };
}
