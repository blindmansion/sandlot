/**
 * Package installation module
 *
 * Provides the complete package installation pipeline:
 * - Resolution: Build dependency tree and install plan
 * - Execution: Download packages and create symlinks
 * - Lockfile: Generate and read package-lock.json
 *
 * Use `createInstallCommands()` to get ready-made commands:
 *
 * ```ts
 * import { createInstallCommands } from "sandlot/install";
 *
 * const cmds = createInstallCommands();
 * const bash = new Bash({
 *   customCommands: [cmds.install.toCommand(), cmds.uninstall.toCommand(), cmds.upgrade.toCommand()],
 *   fs: new InMemoryFs({ "/package.json": '{ "name": "my-app" }' }),
 * });
 * await bash.exec("install nanoid");
 * ```
 */

// Filesystem interface
export type {
	FileContent,
	InstallFileStat,
	InstallFileSystem,
	InstallMkdirOptions,
	InstallRmOptions,
} from "./fs";
// Helpers
export {
	type DepType,
	getProjectRoot,
	type ProjectRoot,
	readDepsFromPackageJson,
	removeFromPackageJson,
	saveToPackageJson,
} from "./helpers";
// Install - for installing packages
export { install } from "./install";
export type {
	ReconcileProjectOptions,
	ReconcileProjectResult,
} from "./reconcile";
export { reconcileProjectInstall } from "./reconcile";
// Store - public utilities only
export { clearStore, getStoreStats } from "./store";

// Core types
export type {
	EventHandler,
	InstallEvent,
	InstallerConfig,
	InstallFn,
	InstallOptions,
	InstallPlan,
	InstallResult,
	InstallStats,
	LinkEntry,
	ResolvedPackage,
	StorePackage,
	VersionConflict,
} from "./types";
// Global store path constant
export { GLOBAL_STORE_PATH } from "./types";
