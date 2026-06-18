/**
 * Lockfile generation and parsing
 *
 * The lockfile (package-lock.json) stores:
 * - Exact versions of every package
 * - Integrity hashes for verification
 * - Resolved URLs
 * - Store paths in the global store (e.g., /.store/{name}/{version}/...)
 * - Nested paths for version conflicts
 *
 * This allows reproducible installs without re-resolving.
 */

import { join } from "../util";
import type { InstallFileSystem } from "./fs";
import { getPackageStorePath } from "./store";
import type {
	DependencyLink,
	InstallPlan,
	LinkEntry,
	Lockfile,
	LockfileEntry,
	ResolvedPackage,
} from "./types";
import { GLOBAL_STORE_PATH } from "./types";

const LOCKFILE_VERSION = 3; // Uses global .store structure for package storage

/**
 * Extended lockfile entry with store path info
 */
export interface ExtendedLockfileEntry extends LockfileEntry {
	/** Path in the global store (e.g., "/.store/lodash/4.17.21/node_modules/lodash") */
	storePath?: string;
	/** If nested, which package this is nested under */
	nestedUnder?: string;
	/** Dependency links for this package */
	dependencyLinks?: Array<{ name: string; targetKey: string }>;
}

/**
 * Extended lockfile with pnpm-style metadata
 */
export interface ExtendedLockfile extends Lockfile {
	/** Packages map now uses ExtendedLockfileEntry */
	packages: Record<string, ExtendedLockfileEntry>;
}

/**
 * Generate a lockfile from an install plan
 */
export function generateLockfileFromPlan(
	name: string,
	plan: InstallPlan,
): ExtendedLockfile {
	const lockfilePackages: Record<string, ExtendedLockfileEntry> = {};

	// Build a map of links by name for quick lookup
	const linksByPath = new Map<string, LinkEntry>();
	for (const link of plan.links) {
		linksByPath.set(link.linkPath, link);
	}

	// Process all store packages
	for (const [, sp] of plan.storePackages) {
		const pkg = sp.package;

		// Find all links that point to this package
		const links = plan.links.filter(
			(l) => l.name === pkg.name && l.version === pkg.version,
		);

		for (const link of links) {
			// Extract the lockfile path from the link path
			// Convert absolute paths to relative node_modules paths
			// /path/to/test_modules/lodash -> node_modules/lodash
			// /path/to/node_modules/pkg/node_modules/lodash -> node_modules/pkg/node_modules/lodash
			let lockfilePath = link.linkPath;

			// Find the node_modules or test_modules part and normalize to node_modules
			const nodeModulesIndex = lockfilePath.lastIndexOf("node_modules/");
			const testModulesIndex = lockfilePath.lastIndexOf("test_modules/");
			const moduleIndex = Math.max(nodeModulesIndex, testModulesIndex);

			if (moduleIndex !== -1) {
				// Extract from the modules directory onwards and normalize to node_modules
				lockfilePath =
					"node_modules/" +
					lockfilePath
						.slice(moduleIndex)
						.replace(/^(node_modules|test_modules)\//, "");
			}

			// Convert dependencies back to Record format
			const deps: Record<string, string> | undefined =
				pkg.dependencies.length > 0
					? Object.fromEntries(
						pkg.dependencies.map((d) => [d.name, d.versionRange]),
					)
					: undefined;

			// Convert optionalDependencies back to Record format
			const optionalDeps: Record<string, string> | undefined =
				pkg.optionalDependencies.length > 0
					? Object.fromEntries(
						pkg.optionalDependencies.map((d) => [d.name, d.versionRange]),
					)
					: undefined;

			// Convert peerDependencies back to Record format
			const peerDeps: Record<string, string> | undefined =
				pkg.peerDependencies.length > 0
					? Object.fromEntries(
						pkg.peerDependencies.map((d) => [d.name, d.versionRange]),
					)
					: undefined;

			// Include peerDependenciesMeta if there are any entries
			const peerMeta =
				Object.keys(pkg.peerDependenciesMeta).length > 0
					? pkg.peerDependenciesMeta
					: undefined;

			lockfilePackages[lockfilePath] = {
				version: pkg.version,
				resolved: pkg.tarballUrl,
				integrity: pkg.integrity,
				dependencies: deps,
				optionalDependencies: optionalDeps,
				peerDependencies: peerDeps,
				peerDependenciesMeta: peerMeta,
				optional: pkg.isOptional || undefined,
				storePath: sp.storePath,
				nestedUnder: link.nestedUnder,
				dependencyLinks:
					sp.dependencyLinks.length > 0 ? sp.dependencyLinks : undefined,
			};
		}
	}

	return {
		name,
		lockfileVersion: LOCKFILE_VERSION,
		packages: lockfilePackages,
	};
}

/**
 * Write lockfile to disk
 */
export async function writeLockfile(
	fs: InstallFileSystem,
	lockfile: Lockfile | ExtendedLockfile,
	directory: string,
): Promise<void> {
	const path = join(directory, "package-lock.json");
	const content = JSON.stringify(lockfile, null, 2);
	await fs.writeFile(path, content);
}

/**
 * Read lockfile from disk
 */
export async function readLockfile(
	fs: InstallFileSystem,
	directory: string,
): Promise<ExtendedLockfile | null> {
	const path = join(directory, "package-lock.json");

	try {
		if (!(await fs.exists(path))) {
			return null;
		}
		const content = await fs.readFile(path);
		return JSON.parse(content);
	} catch {
		return null;
	}
}

/**
 * Convert lockfile entries back to ResolvedPackage map
 * Used when installing from lockfile (faster, no resolution needed)
 */
export function lockfileToPackages(
	lockfile: Lockfile | ExtendedLockfile,
): Map<string, ResolvedPackage> {
	const packages = new Map<string, ResolvedPackage>();

	for (const [path, entry] of Object.entries(lockfile.packages)) {
		// Extract package name from path
		// "node_modules/lodash" -> "lodash"
		// "node_modules/pkg/node_modules/lodash" -> "lodash" (but will be handled specially)
		const parts = path.split("node_modules/");
		const name = parts[parts.length - 1] || "";
		if (!name) continue; // Skip invalid entries

		// For nested packages, we use a special key that includes the parent
		const extEntry = entry as ExtendedLockfileEntry;
		const key = extEntry.nestedUnder ? `${extEntry.nestedUnder}>${name}` : name;

		packages.set(key, {
			name,
			version: entry.version,
			resolved: entry.resolved,
			integrity: entry.integrity,
			tarballUrl: entry.resolved,
			dependencies: entry.dependencies
				? Object.entries(entry.dependencies).map(([n, v]) => ({
					name: n,
					versionRange: v,
				}))
				: [],
			optionalDependencies: entry.optionalDependencies
				? Object.entries(entry.optionalDependencies).map(([n, v]) => ({
					name: n,
					versionRange: v,
				}))
				: [],
			peerDependencies: entry.peerDependencies
				? Object.entries(entry.peerDependencies).map(([n, v]) => ({
					name: n,
					versionRange: v,
				}))
				: [],
			peerDependenciesMeta: entry.peerDependenciesMeta || {},
			isOptional: entry.optional,
		});
	}

	return packages;
}

/**
 * Convert lockfile entries to an InstallPlan
 * This preserves the nested structure from the lockfile
 */
export function lockfileToInstallPlan(
	lockfile: ExtendedLockfile,
	nodeModulesPath: string,
): InstallPlan {
	const storePackages = new Map<string, import("./types").StorePackage>();
	const links: import("./types").LinkEntry[] = [];

	for (const [path, entry] of Object.entries(lockfile.packages)) {
		const extEntry = entry as ExtendedLockfileEntry;

		// Extract package name from path
		// "node_modules/chalk" -> "chalk"
		// "node_modules/pkg/node_modules/chalk" -> "chalk"
		const parts = path.split("node_modules/");
		const name = parts[parts.length - 1] || "";
		if (!name) continue; // Skip invalid entries

		// Build ResolvedPackage
		const pkg: ResolvedPackage = {
			name,
			version: entry.version,
			resolved: entry.resolved,
			integrity: entry.integrity,
			tarballUrl: entry.resolved,
			dependencies: entry.dependencies
				? Object.entries(entry.dependencies).map(([n, v]) => ({
					name: n,
					versionRange: v,
				}))
				: [],
			optionalDependencies: entry.optionalDependencies
				? Object.entries(entry.optionalDependencies).map(([n, v]) => ({
					name: n,
					versionRange: v,
				}))
				: [],
			peerDependencies: entry.peerDependencies
				? Object.entries(entry.peerDependencies).map(([n, v]) => ({
					name: n,
					versionRange: v,
				}))
				: [],
			peerDependenciesMeta: entry.peerDependenciesMeta || {},
			isOptional: entry.optional,
		};

		// Add to store packages (deduplicated by name@version)
		const key = `${name}@${entry.version}`;
		// Use storePath from lockfile if available, otherwise compute from global store
		const pkgStorePath =
			extEntry.storePath ||
			getPackageStorePath(GLOBAL_STORE_PATH, name, entry.version);

		// Parse dependency links from lockfile or empty array
		const dependencyLinks: DependencyLink[] = extEntry.dependencyLinks || [];

		if (!storePackages.has(key)) {
			storePackages.set(key, {
				package: pkg,
				storePath: pkgStorePath,
				dependencyLinks,
			});
		}

		// Determine link path
		// path is like "node_modules/lodash" or "node_modules/pkg/node_modules/lodash"
		// We need to replace the first "node_modules" with the actual nodeModulesPath
		const linkPath = path.replace(/^node_modules/, nodeModulesPath);

		links.push({
			name,
			version: entry.version,
			linkPath,
			targetPath: pkgStorePath,
			isNested: !!extEntry.nestedUnder,
			nestedUnder: extEntry.nestedUnder,
		});
	}

	return {
		storePackages,
		links,
		conflicts: [], // Conflicts already resolved in lockfile
		stats: {
			totalPackages: storePackages.size,
			uniqueVersions: storePackages.size,
			hoistedPackages: links.filter((l) => !l.isNested).length,
			nestedPackages: links.filter((l) => l.isNested).length,
			conflictCount: 0,
		},
	};
}
