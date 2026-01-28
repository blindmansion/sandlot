// =============================================================================
// Browser polyfills - inject before anything else loads
// =============================================================================

// Some dependencies (like just-bash) reference Node.js globals.
// Provide shims so they work in the browser without user configuration.
if (typeof window !== "undefined" && typeof globalThis.process === "undefined") {
  (globalThis as Record<string, unknown>).process = {
    env: {},
    platform: "browser",
    version: "v20.0.0",
    browser: true,
    cwd: () => "/",
    nextTick: (fn: () => void) => setTimeout(fn, 0),
  };
}

// =============================================================================
// CORE API - Most users only need these
// =============================================================================

// -----------------------------------------------------------------------------
// Sandbox API
// -----------------------------------------------------------------------------

export {
  createSandbox,
  type Sandbox,
  type SandboxOptions,
  type SandboxState,
  type SandboxBashOptions,
} from "./sandbox";

// -----------------------------------------------------------------------------
// Builder (recommended for agent workflows)
// -----------------------------------------------------------------------------

export {
  createBuilder,
  type BuildResult,
  type CreateBuilderOptions,
  type BuildCallOptions,
  type BuilderFn,
} from "./builder";

// -----------------------------------------------------------------------------
// Module Loading (use after build to get exports)
// -----------------------------------------------------------------------------

export {
  loadModule,
  loadExport,
  loadDefault,
  getExportNames,
  hasExport,
  ModuleLoadError,
  ExportNotFoundError,
} from "./loader";

// -----------------------------------------------------------------------------
// Shared Modules (for React/library sharing with host)
// -----------------------------------------------------------------------------

export {
  registerSharedModules,
  unregisterSharedModule,
  clearSharedModules,
} from "./shared-modules";

// -----------------------------------------------------------------------------
// Common Types
// -----------------------------------------------------------------------------

export type { BundleResult } from "./bundler";
export type { BuildOutput, ValidateFn } from "./commands/types";
export type { TypecheckResult, Diagnostic } from "./typechecker";
export type { PackageManifest, InstallResult } from "./packages";


// =============================================================================
// ADVANCED API - For power users and custom integrations
// =============================================================================

// -----------------------------------------------------------------------------
// Direct Bundler Access
// -----------------------------------------------------------------------------

export {
  initBundler,
  bundle,
  bundleToUrl,
  bundleAndImport,
  type BundleOptions,
  type NpmImportsMode,
} from "./bundler";

// -----------------------------------------------------------------------------
// Direct Typechecker Access
// -----------------------------------------------------------------------------

export {
  typecheck,
  formatDiagnostics,
  formatDiagnosticsForAgent,
  type TypecheckOptions,
} from "./typechecker";

// -----------------------------------------------------------------------------
// Package Management
// -----------------------------------------------------------------------------

export {
  installPackage,
  uninstallPackage,
  listPackages,
  getPackageManifest,
  type InstallOptions,
} from "./packages";

// -----------------------------------------------------------------------------
// Shared Resources (for custom resource management)
// -----------------------------------------------------------------------------

export {
  createSharedResources,
  getDefaultResources,
  clearDefaultResources,
  hasDefaultResources,
  type SharedResourcesOptions,
  type SharedResources,
  type TypesCache,
} from "./shared-resources";

// -----------------------------------------------------------------------------
// Filesystem (for custom VFS usage)
// -----------------------------------------------------------------------------

export {
  Filesystem,
  createFilesystem,
  type FilesystemOptions,
} from "./fs";

export type { IFileSystem, FsEntry } from "just-bash/browser";

// -----------------------------------------------------------------------------
// TypeScript Library Utilities
// -----------------------------------------------------------------------------

export {
  getDefaultBrowserLibs,
  fetchAndCacheLibs,
} from "./ts-libs";

// -----------------------------------------------------------------------------
// Command Factories (for custom sandbox commands)
// -----------------------------------------------------------------------------

export {
  createTscCommand,
  createBuildCommand,
  createInstallCommand,
  createUninstallCommand,
  createListCommand,
  createRunCommand,
  createDefaultCommands,
  type CommandDeps,
  type RunContext,
  type RunOptions,
  type RunResult,
} from "./commands/index";
