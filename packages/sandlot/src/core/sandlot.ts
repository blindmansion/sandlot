import type {
  Sandlot,
  SandlotOptions,
  SandboxOptions,
  Sandbox,
  ISharedModuleRegistry,
} from "../types";
import { createSharedModuleRegistry } from "./shared-module-registry";
import { createSandboxImpl, type SandboxContext } from "./sandbox";
import { Filesystem } from "./fs";
import { Typechecker } from "./typechecker";
import { EsmTypesResolver } from "./esm-types-resolver";

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
    typechecker: providedTypechecker,
    typesResolver: providedTypesResolver,
    executor,
    sharedModules,
    persistor,
    sandboxDefaults = {},
  } = options;

  // Use provided components, or create new ones with persistor caching
  const typechecker = providedTypechecker ?? (persistor
    ? new Typechecker({ cache: persistor.tsLibs })
    : undefined
  );

  const typesResolver = providedTypesResolver ?? (persistor
    ? new EsmTypesResolver({ cache: persistor.packageTypes })
    : undefined
  );

  // Create shared module registry if modules were provided
  const sharedModuleRegistry = createSharedModuleRegistry(sharedModules);

  // Create the context that will be passed to each sandbox
  const sandboxContext: SandboxContext = {
    bundler,
    typechecker,
    typesResolver,
    sharedModuleRegistry,
    executor,
  };

  return {
    async createSandbox(sandboxOptions: SandboxOptions = {}): Promise<Sandbox> {
      // Create the virtual filesystem
      const fs = Filesystem.create({
        maxSizeBytes: sandboxOptions.maxFilesystemSize ?? sandboxDefaults.maxFilesystemSize,
        // Note: initialFiles will be written by createSandboxImpl
      });

      // Create and return the sandbox
      return createSandboxImpl(fs, sandboxOptions, sandboxContext);
    },

    get sharedModules(): ISharedModuleRegistry | null {
      return sharedModuleRegistry;
    },

    async dispose(): Promise<void> {
      // Dispose of the bundler if it has a dispose method
      if (bundler.dispose) {
        await bundler.dispose();
      }
    },
  };
}
