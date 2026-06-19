import { dirname } from "../util";
import { executeInstallPlan } from "./executor";
import type { InstallFileSystem } from "./fs";
import { generateLockfileFromPlan, writeLockfile } from "./lockfile";
import { resolveDependencies } from "./resolver";
import {
	DEFAULT_CONFIG,
	GLOBAL_STORE_PATH,
	type InstallOptions,
	type InstallResult,
} from "./types";

export async function install(
	fs: InstallFileSystem,
	packages: string[],
	options: InstallOptions,
): Promise<InstallResult[]> {
	if (packages.length === 0) {
		return [];
	}

	const { nodeModulesPath, projectName } = options;

	// Create config with per-project nodeModulesPath and global store path.
	// The resolver uses config.storePath for package storage paths and
	// config.nodeModulesPath for per-project symlink paths.
	const config = {
		...DEFAULT_CONFIG,
		nodeModulesPath,
		storePath: GLOBAL_STORE_PATH,
	};

	// Resolve dependencies
	const resolution = await resolveDependencies(packages, config);

	// Execute install plan (downloads packages, creates symlinks)
	// Use baseFs directly to bypass observable wrapper - package installation
	// writes hundreds of files and we don't need file change events for each one.
	// This dramatically improves install performance in the browser.
	await executeInstallPlan(resolution.plan, {
		config,
		fs,
	});

	const lockfile = generateLockfileFromPlan(projectName, resolution.plan);
	// Write lockfile to the project root (parent of nodeModulesPath)
	await writeLockfile(fs, lockfile, dirname(nodeModulesPath));

	// Build result
	const installed: InstallResult[] = [];
	for (const [, sp] of resolution.plan.storePackages) {
		installed.push({
			name: sp.package.name,
			version: sp.package.version,
			path: sp.storePath,
		});
	}

	return installed;
}
