/**
 * Command factories for sandbox bash environments.
 *
 * Pure factories that create commands for type checking, bundling,
 * package management, and code execution.
 * No global state - all dependencies are passed in explicitly.
 */

// Types and utilities
export {
  type CommandDeps,
  type BuildOutput,
  type ValidateFn,
  type RunContext,
  type RunOptions,
  type RunResult,
  formatEsbuildMessages,
} from "./types";

// Compile commands (tsc, build)
export { createTscCommand, createBuildCommand } from "./compile";

// Package management commands (install, uninstall, list)
export {
  createInstallCommand,
  createUninstallCommand,
  createListCommand,
} from "./packages";

// Run command
export { createRunCommand } from "./run";

// Re-import for createDefaultCommands
import type { CommandDeps } from "./types";
import { createTscCommand, createBuildCommand } from "./compile";
import { createInstallCommand, createUninstallCommand, createListCommand } from "./packages";
import { createRunCommand } from "./run";

/**
 * Create all default sandbox commands
 */
export function createDefaultCommands(deps: CommandDeps) {
  return [
    createTscCommand(deps),
    createBuildCommand(deps),
    createRunCommand(deps),
    createInstallCommand(deps),
    createUninstallCommand(deps),
    createListCommand(deps),
  ];
}
