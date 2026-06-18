/**
 * Package store - global content-addressable storage for packages
 *
 * Uses a single shared store at a global path (e.g., /.store/):
 * - Packages are stored at {storePath}/{name}/{version}/node_modules/{name}/
 * - Each package has its own node_modules/ with absolute symlinks to its dependencies
 * - Enables Node.js runtime resolution of inter-package dependencies
 * - Per-project node_modules/ contains absolute symlinks into the global store
 */

import { dirname, join } from "../util";
import type { InstallFileSystem } from "./fs";
import { createSpec, extractPackage } from "./registry";
import type {
	DependencyLink,
	EventHandler,
	LinkEntry,
	ResolvedPackage,
} from "./types";

/**
 * Store entry metadata
 */
interface StoreEntry {
	name: string;
	version: string;
	integrity: string;
	storedAt: number;
}

/**
 * Get the store path for a package in the global store layout.
 *
 * Layout: {storePath}/{name}/{version}/node_modules/{name}
 * Examples:
 *   /.store/lodash/4.17.21/node_modules/lodash
 *   /.store/@types/react/18.3.0/node_modules/@types/react
 */
export function getPackageStorePath(
	storePath: string,
	name: string,
	version: string,
): string {
	return join(storePath, name, version, "node_modules", name);
}

/**
 * Check if a package exists in the store
 */
export async function isInStore(
	fs: InstallFileSystem,
	storePath: string,
	name: string,
	version: string,
): Promise<boolean> {
	const pkgPath = getPackageStorePath(storePath, name, version);

	try {
		const stats = await fs.stat(pkgPath);
		return stats.isDirectory;
	} catch {
		return false;
	}
}

/**
 * Extract a package to the store
 * Returns the path where the package was stored
 */
export async function extractToStore(
	fs: InstallFileSystem,
	pkg: ResolvedPackage,
	storePath: string,
	registry: string,
	onEvent?: EventHandler,
): Promise<string> {
	const destPath = getPackageStorePath(storePath, pkg.name, pkg.version);

	// Check if already in store
	if (await isInStore(fs, storePath, pkg.name, pkg.version)) {
		onEvent?.({ type: "stored", package: pkg, storePath: destPath });
		return destPath;
	}

	// Ensure store directory exists (handles scoped packages with nested paths)
	await fs.mkdir(dirname(destPath), { recursive: true });

	// Download and extract
	const spec = createSpec(pkg.name, pkg.version);

	onEvent?.({ type: "downloading", package: pkg });
	onEvent?.({ type: "extracting", package: pkg });

	await extractPackage(spec, destPath, { registry, fs });

	// Write metadata file
	const metadata: StoreEntry = {
		name: pkg.name,
		version: pkg.version,
		integrity: pkg.integrity,
		storedAt: Date.now(),
	};
	await fs.writeFile(
		join(destPath, ".store-meta.json"),
		JSON.stringify(metadata, null, 2),
	);

	onEvent?.({ type: "stored", package: pkg, storePath: destPath });

	return destPath;
}

/**
 * Create an absolute symlink from per-project node_modules to the global store
 */
export async function createLink(
	fs: InstallFileSystem,
	link: LinkEntry,
	onEvent?: EventHandler,
): Promise<void> {
	onEvent?.({
		type: "linking",
		name: link.name,
		version: link.version,
		linkPath: link.linkPath,
		isNested: link.isNested,
	});

	// Ensure parent directory exists (for nested links like node_modules/pkg/node_modules/)
	const parentDir = dirname(link.linkPath);
	await fs.mkdir(parentDir, { recursive: true });

	// Check if link already exists
	try {
		const existingTarget = await fs.readlink(link.linkPath);
		// Link exists - check if it points to the right place
		if (existingTarget === link.targetPath) {
			onEvent?.({
				type: "linked",
				name: link.name,
				version: link.version,
				linkPath: link.linkPath,
			});
			return;
		}
		// Wrong target - remove and recreate
		await fs.rm(link.linkPath, { recursive: true, force: true });
	} catch {
		// Link doesn't exist or isn't a symlink - might be a directory
		try {
			await fs.rm(link.linkPath, { recursive: true, force: true });
		} catch {
			// Ignore - might not exist
		}
	}

	// Create the symlink with an absolute target path
	await fs.symlink(link.targetPath, link.linkPath);

	onEvent?.({
		type: "linked",
		name: link.name,
		version: link.version,
		linkPath: link.linkPath,
	});
}

/**
 * Create a dependency link from a package's node_modules to another package in the global store.
 * This enables Node.js runtime resolution of inter-package dependencies.
 *
 * @param fs - Filesystem interface
 * @param depLink - The dependency link to create
 * @param sourceStorePath - The store path of the package that has this dependency
 * @param targetStorePath - The store path of the dependency package
 */
export async function createDependencyLink(
	fs: InstallFileSystem,
	depLink: DependencyLink,
	sourceStorePath: string,
	targetStorePath: string,
): Promise<void> {
	// Link goes in the same node_modules/ directory as the source package
	// e.g., if source is /.store/fastify/5.7.2/node_modules/fastify
	// then link is /.store/fastify/5.7.2/node_modules/avvio
	const linkPath = join(dirname(sourceStorePath), depLink.name);
	const parentDir = dirname(linkPath);

	// Ensure parent directory exists
	await fs.mkdir(parentDir, { recursive: true });

	// Check if link already exists
	try {
		await fs.lstat(linkPath);
		// Link exists - remove it
		await fs.rm(linkPath, { recursive: true, force: true });
	} catch {
		// Link doesn't exist - that's fine
	}

	// Create the symlink with an absolute target path
	await fs.symlink(targetStorePath, linkPath);
}

/**
 * Clear the entire global store
 */
export async function clearStore(
	fs: InstallFileSystem,
	storePath: string,
): Promise<void> {
	try {
		await fs.rm(storePath, {
			recursive: true,
			force: true,
		});
	} catch {
		// Ignore errors (store might not exist)
	}
}

/**
 * Get store statistics.
 *
 * Walks the store layout: {storePath}/{name}/{version}/node_modules/{name}/
 * Scoped packages add one level: {storePath}/@scope/{pkg}/{version}/node_modules/@scope/{pkg}/
 */
export async function getStoreStats(
	fs: InstallFileSystem,
	storePath: string,
): Promise<{
	entries: number;
	packages: Array<{ name: string; version: string; storedAt: Date }>;
}> {
	const packages: Array<{ name: string; version: string; storedAt: Date }> = [];

	/** Read metadata for a package at {storePath}/{name}/{version}/ */
	async function readPackageMeta(
		name: string,
		versionDir: string,
	): Promise<void> {
		const metaPath = join(versionDir, "node_modules", name, ".store-meta.json");
		try {
			const metaContent = await fs.readFile(metaPath);
			const meta = JSON.parse(metaContent) as StoreEntry;
			packages.push({
				name: meta.name,
				version: meta.version,
				storedAt: new Date(meta.storedAt),
			});
		} catch {
			// No metadata - skip
		}
	}

	/** Scan version directories for a given package name */
	async function scanVersions(name: string, packageDir: string): Promise<void> {
		try {
			const versions = await fs.readdir(packageDir);
			for (const version of versions) {
				await readPackageMeta(name, join(packageDir, version));
			}
		} catch {
			// Can't read directory - skip
		}
	}

	try {
		const topEntries = await fs.readdir(storePath);

		for (const entry of topEntries) {
			if (entry.startsWith("@")) {
				// Scoped package: /.store/@scope/{pkg}/{version}/...
				try {
					const scopeDir = join(storePath, entry);
					const scopedPkgs = await fs.readdir(scopeDir);
					for (const pkg of scopedPkgs) {
						await scanVersions(`${entry}/${pkg}`, join(scopeDir, pkg));
					}
				} catch {
					// Can't read scope directory - skip
				}
			} else {
				// Regular package: /.store/{name}/{version}/...
				await scanVersions(entry, join(storePath, entry));
			}
		}
	} catch {
		// Store doesn't exist
	}

	return {
		entries: packages.length,
		packages,
	};
}

/**
 * Ensure the store directory exists
 */
export async function ensureStore(
	fs: InstallFileSystem,
	storePath: string,
): Promise<void> {
	await fs.mkdir(storePath, { recursive: true });
}

/**
 * Verify that a symlink points to a valid store location
 */
export async function verifyLink(
	fs: InstallFileSystem,
	linkPath: string,
): Promise<{
	valid: boolean;
	target?: string;
	error?: string;
}> {
	try {
		const stats = await fs.lstat(linkPath);
		if (!stats.isSymbolicLink) {
			return { valid: false, error: "Not a symlink" };
		}

		const target = await fs.readlink(linkPath);

		// Check if target exists
		try {
			await fs.stat(linkPath); // This follows the symlink
			return { valid: true, target };
		} catch {
			return {
				valid: false,
				target,
				error: "Broken symlink - target does not exist",
			};
		}
	} catch {
		return { valid: false, error: "Link does not exist" };
	}
}
