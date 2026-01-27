import { Bash, defineCommand, type BashOptions } from "just-bash/browser";
import { Filesystem, type FilesystemOptions } from "./fs";
import { initBundler } from "./bundler";
import { createDefaultCommands, type CommandDeps, type BuildOutput, type ValidateFn } from "./commands";
import { getDefaultResources, type SharedResources } from "./shared-resources";
import { BuildEmitter } from "./build-emitter";
import { installPackage, parseImportPath } from "./packages";

/**
 * Options that can be passed through to the just-bash Bash constructor.
 * Excludes options that sandlot controls internally (fs, customCommands, files, cwd).
 * The working directory is always root (/).
 */
export type SandboxBashOptions = Omit<BashOptions, 'fs' | 'customCommands' | 'files' | 'cwd'>;

/**
 * Options for creating a sandbox environment
 */
export interface SandboxOptions {
  /**
   * Initial files to populate the filesystem with.
   * 
   * @example
   * ```ts
   * const sandbox = await createSandbox({
   *   initialFiles: {
   *     '/src/index.ts': 'export const x = 1;',
   *     '/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
   *   },
   * });
   * ```
   */
  initialFiles?: Record<string, string>;

  /**
   * Maximum filesystem size in bytes (default: 50MB)
   */
  maxFilesystemSize?: number;

  /**
   * Path to tsconfig.json in the virtual filesystem.
   * Default: "/tsconfig.json"
   */
  tsconfigPath?: string;

  /**
   * Shared resources (lib files, bundler).
   * If not provided, uses the default singleton resources.
   * 
   * Provide this to share resources across multiple sandboxes,
   * or to use custom TypeScript libs.
   */
  resources?: SharedResources;

  /**
   * Callback invoked when a build succeeds.
   * Receives the build output with the bundle and loaded module.
   *
   * For agent workflows, prefer using `createBuilder()` which handles
   * build capture automatically.
   */
  onBuild?: (result: BuildOutput) => void | Promise<void>;

  /**
   * Additional custom commands to add to the bash environment
   */
  customCommands?: ReturnType<typeof defineCommand>[];

  /**
   * Module IDs that should be resolved from the host's SharedModuleRegistry
   * instead of esm.sh CDN. The host must have registered these modules
   * using `registerSharedModules()` before loading dynamic code.
   *
   * This solves the "multiple React instances" problem by allowing dynamic
   * components to share the same React instance as the host application.
   *
   * Type definitions are automatically installed for these modules so that
   * TypeScript can typecheck code that imports them.
   *
   * @example
   * ```ts
   * // Host setup
   * import * as React from 'react';
   * import * as ReactDOM from 'react-dom/client';
   * import { registerSharedModules } from 'sandlot';
   *
   * registerSharedModules({
   *   'react': React,
   *   'react-dom/client': ReactDOM,
   * });
   *
   * // Create sandbox with shared modules (types auto-installed)
   * const sandbox = await createSandbox({
   *   sharedModules: ['react', 'react-dom/client'],
   * });
   * ```
   */
  sharedModules?: string[];

  /**
   * Options passed through to the just-bash Bash constructor.
   * Use this to configure environment variables, execution limits, 
   * network access, logging, and other bash-level settings.
   * 
   * Note: `fs`, `customCommands`, `files`, and `cwd` are controlled by sandlot
   * and cannot be overridden here. The working directory is always root (/).
   * 
   * @example
   * ```ts
   * const sandbox = await createSandbox({
   *   bashOptions: {
   *     env: { NODE_ENV: 'development' },
   *     executionLimits: { maxCommandCount: 1000 },
   *   },
   * });
   * ```
   */
  bashOptions?: SandboxBashOptions;
}

/**
 * Sandbox state that can be serialized for persistence.
 */
export interface SandboxState {
  /**
   * All files in the filesystem as path -> content mapping.
   * Can be passed as `initialFiles` when creating a new sandbox.
   */
  files: Record<string, string>;
}

/**
 * The sandbox environment containing the filesystem and bash shell
 */
export interface Sandbox {
  /**
   * The virtual filesystem
   */
  fs: Filesystem;

  /**
   * The just-bash shell environment
   */
  bash: Bash;

  /**
   * The last successful build output, or null if no build has succeeded yet.
   *
   * This is updated automatically whenever a `build` command succeeds.
   * Contains both the bundle and the loaded (and validated, if applicable) module.
   *
   * @example
   * ```ts
   * // Agent loop pattern
   * while (!sandbox.lastBuild) {
   *   const response = await agent.step();
   *   await sandbox.bash.exec(response.command);
   * }
   * // Build succeeded, sandbox.lastBuild contains bundle + module
   * const App = sandbox.lastBuild.module.App;
   * ```
   */
  lastBuild: BuildOutput | null;

  /**
   * Get the current sandbox state for persistence.
   * 
   * Returns a serializable object containing all files that can be
   * JSON-serialized and used to restore the sandbox later.
   * 
   * @example
   * ```ts
   * // Save sandbox state
   * const state = sandbox.getState();
   * localStorage.setItem('my-project', JSON.stringify(state));
   * 
   * // Later, restore the sandbox
   * const saved = JSON.parse(localStorage.getItem('my-project'));
   * const sandbox2 = await createSandbox({ initialFiles: saved.files });
   * ```
   */
  getState(): SandboxState;

  /**
   * Subscribe to build events. Called whenever a build succeeds.
   * Returns an unsubscribe function.
   *
   * For agent workflows, prefer using `createBuilder()` which handles
   * build capture automatically. Use `onBuild` directly when you need
   * more control over the subscription lifecycle.
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
  onBuild(callback: (result: BuildOutput) => void | Promise<void>): () => void;

  /**
   * Set a validation function for the build command.
   *
   * When set, the build command will run this function after loading
   * the module. If validation throws, the build fails and the agent
   * sees the error. If validation passes, the validated module is
   * available in the build output.
   *
   * @example
   * ```ts
   * sandbox.setValidation((mod) => {
   *   if (!mod.App) throw new Error("Must export App component");
   *   return { App: mod.App as React.ComponentType };
   * });
   *
   * // Now build will fail if App is missing
   * await sandbox.bash.exec('build /src/index.ts');
   * ```
   */
  setValidation(fn: ValidateFn): void;

  /**
   * Clear the validation function.
   * After calling this, builds will not perform validation.
   */
  clearValidation(): void;
}

/**
 * Create an in-browser agent sandbox with a virtual filesystem, TypeScript
 * type checking, and bundling capabilities.
 *
 * The sandbox provides a just-bash shell with custom commands:
 * - `tsc [entry]` - Type check the project
 * - `build [entry] [options]` - Build the project (runs typecheck first)
 * - `install <pkg>` - Install npm packages
 * - `uninstall <pkg>` - Remove packages
 * - `list` - List installed packages
 * - `run <entry>` - Run a script
 *
 * Build options:
 * - `--format, -f <esm|iife|cjs>` - Output format (default: esm)
 * - `--minify, -m` - Enable minification
 * - `--skip-typecheck, -s` - Skip type checking
 *
 * @example
 * ```ts
 * let bundleResult: BundleResult | null = null;
 * 
 * const sandbox = await createSandbox({
 *   initialFiles: {
 *     '/src/index.ts': 'export const hello = "world";',
 *     '/tsconfig.json': JSON.stringify({
 *       compilerOptions: { target: 'ES2020', strict: true }
 *     }),
 *   },
 *   onBuild: (result) => {
 *     bundleResult = result;
 *   },
 * });
 *
 * // Use bash commands
 * await sandbox.bash.exec('echo "console.log(1);" > /src/index.ts');
 *
 * // Type check
 * const tscResult = await sandbox.bash.exec('tsc /src/index.ts');
 * console.log(tscResult.stdout);
 *
 * // Build (includes typecheck, triggers onBuild callback)
 * const buildResult = await sandbox.bash.exec('build /src/index.ts');
 * console.log(buildResult.stdout);
 * console.log(bundleResult?.code); // The compiled bundle
 *
 * // Save state for later
 * const state = sandbox.getState();
 * localStorage.setItem('my-project', JSON.stringify(state));
 * ```
 */
export async function createSandbox(options: SandboxOptions = {}): Promise<Sandbox> {
  const {
    initialFiles,
    maxFilesystemSize,
    tsconfigPath = "/tsconfig.json",
    resources: providedResources,
    onBuild: onBuildCallback,
    customCommands = [],
    sharedModules,
    bashOptions = {},
  } = options;

  // Create filesystem (synchronous)
  const fs = Filesystem.create({
    initialFiles,
    maxSizeBytes: maxFilesystemSize,
  });

  // Load shared resources and bundler in parallel
  const resourcesPromise = providedResources
    ? Promise.resolve(providedResources)
    : getDefaultResources();

  const bundlerPromise = initBundler();

  // Wait for async initialization
  const [resources] = await Promise.all([resourcesPromise, bundlerPromise]);

  // Extract lib files and types cache from resources
  const libFiles = resources.libFiles;
  const typesCache = resources.typesCache;

  // Auto-install types for shared modules so TypeScript can typecheck them
  // Only install base packages, not subpath exports (e.g., "react" not "react/jsx-runtime")
  // Subpath types are fetched automatically when the base package is installed
  if (sharedModules && sharedModules.length > 0) {
    // Extract unique base package names
    const basePackages = new Set<string>();
    for (const moduleId of sharedModules) {
      const { packageName } = parseImportPath(moduleId);
      basePackages.add(packageName);
    }

    await Promise.all(
      Array.from(basePackages).map(async (packageName) => {
        try {
          // Install the package to get its type definitions
          // The runtime will use the shared module, but we need types for typechecking
          await installPackage(fs, packageName, { cache: typesCache });
        } catch (err) {
          // Log but don't fail - module might not have types available
          console.warn(`[sandlot] Failed to install types for shared module "${packageName}":`, err);
        }
      })
    );
  }

  // Create build event emitter
  const buildEmitter = new BuildEmitter();

  // Track the last successful build
  let lastBuild: BuildOutput | null = null;
  buildEmitter.on((result) => {
    lastBuild = result;
  });

  // If a callback was provided in options, subscribe it
  if (onBuildCallback) {
    buildEmitter.on(onBuildCallback);
  }

  // Validation function (can be set/cleared dynamically)
  let validationFn: ValidateFn | null = null;

  // Create commands
  const commandDeps: CommandDeps = {
    fs,
    libFiles,
    tsconfigPath,
    onBuild: buildEmitter.emit,
    getValidation: () => validationFn,
    typesCache,
    sharedModules,
  };
  const defaultCommands = createDefaultCommands(commandDeps);

  // Create bash environment with the custom filesystem
  // Always start in root directory (/) for consistent behavior
  const bash = new Bash({
    ...bashOptions,
    cwd: '/',
    fs,
    customCommands: [...defaultCommands, ...customCommands],
  });

  return {
    fs,
    bash,
    get lastBuild() {
      return lastBuild;
    },
    getState: () => ({ files: fs.getFiles() }),
    onBuild: (callback) => buildEmitter.on(callback),
    setValidation: (fn: ValidateFn) => {
      validationFn = fn;
    },
    clearValidation: () => {
      validationFn = null;
    },
  };
}

