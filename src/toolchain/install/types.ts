/**
 * Type definitions for the package manager
 *
 * This package manager uses a global store approach (inspired by pnpm):
 * - Packages are stored once in /.store/{name}/{version}/node_modules/{name}/
 * - Each package has its own node_modules/ with symlinks to its dependencies
 * - Per-project node_modules/ contains absolute symlinks to the global store
 * - Version conflicts are resolved by nesting symlinks
 */

import type { InstallFileSystem } from "./fs";

/** How a dependency is specified in package.json */
export interface DependencySpec {
	name: string;
	versionRange: string; // e.g., "^4.0.0", "~1.2.3", ">=2.0.0"
}

/** Metadata for peer dependencies (e.g., marking them as optional) */
export interface PeerDependencyMeta {
	optional?: boolean;
}

/** Resolved package with exact version */
export interface ResolvedPackage {
	name: string;
	version: string; // Exact version, e.g., "4.1.2"
	dependencies: DependencySpec[];
	optionalDependencies: DependencySpec[];
	peerDependencies: DependencySpec[];
	peerDependenciesMeta: Record<string, PeerDependencyMeta>;
	integrity: string; // SHA hash for verification
	tarballUrl: string;
	resolved: string; // Full URL used to resolve
	/** True if this package was required as an optional dependency */
	isOptional?: boolean;
}

/** A node in the dependency tree */
export interface DependencyNode {
	package: ResolvedPackage;
	dependencies: Map<string, DependencyNode>;
	parent?: DependencyNode;
	depth: number;
}

/** The complete resolved dependency tree */
export interface DependencyTree {
	root: DependencyNode;
	/** Flat map of all packages: name -> resolved package */
	packages: Map<string, ResolvedPackage>;
}

// ============================================================================
// pnpm-style store and linking types
// ============================================================================

/**
 * Tracks a version requirement from a dependent package.
 * Used to determine which version to hoist vs nest.
 */
export interface VersionRequirement {
	/** The package that requires this dependency */
	dependentName: string;
	/** The package that is required */
	dependencyName: string;
	/** The version range requested */
	versionRange: string;
	/** The resolved version that satisfies this range */
	resolvedVersion: string;
	/** Whether this is an optional dependency */
	isOptional: boolean;
}

/**
 * A symlink from a package's node_modules to one of its dependencies.
 * Used in the pnpm-style store to create inter-package links.
 */
export interface DependencyLink {
	/** Dependency name (e.g., "avvio") */
	name: string;
	/** Target package key (e.g., "avvio@9.1.0") */
	targetKey: string;
}

/**
 * Represents a unique package instance in the store.
 * Key is `${name}@${version}`.
 */
export interface StorePackage {
	/** Package metadata */
	package: ResolvedPackage;
	/**
	 * Path where the package content is extracted in the global store.
	 * e.g., "/.store/lodash/4.17.21/node_modules/lodash"
	 */
	storePath: string;
	/**
	 * Symlinks to create for this package's dependencies.
	 * Each link goes from this package's node_modules/ to the dependency in the global store.
	 */
	dependencyLinks: DependencyLink[];
}

/**
 * A symlink to be created from per-project node_modules to the global store.
 * These are the "hoisted" links that make packages accessible from user code.
 */
export interface LinkEntry {
	/** Package name and version being linked */
	name: string;
	version: string;
	/**
	 * Where the symlink should be created (per-project).
	 * For hoisted: "/projects/greeter/node_modules/lodash"
	 * For nested: "/projects/greeter/node_modules/some-pkg/node_modules/lodash"
	 */
	linkPath: string;
	/**
	 * Where the symlink should point to (in the global store).
	 * e.g., "/.store/lodash/4.17.21/node_modules/lodash"
	 */
	targetPath: string;
	/** True if this is a nested (non-hoisted) link */
	isNested: boolean;
	/** If nested, which package requires this specific version */
	nestedUnder?: string;
}

/**
 * The complete installation plan output by the resolver.
 * Describes what to put in the store and what symlinks to create.
 */
export interface InstallPlan {
	/** Unique packages to install in the store (deduplicated by name@version) */
	storePackages: Map<string, StorePackage>;
	/** Symlinks to create in node_modules */
	links: LinkEntry[];
	/** Version conflicts that were detected */
	conflicts: VersionConflict[];
	/** Stats about the resolution */
	stats: {
		totalPackages: number;
		uniqueVersions: number;
		hoistedPackages: number;
		nestedPackages: number;
		conflictCount: number;
	};
}

/**
 * A version conflict: multiple packages need different versions of the same dependency.
 */
export interface VersionConflict {
	/** The package with multiple versions needed */
	packageName: string;
	/** The version that will be hoisted to the top level */
	hoistedVersion: string;
	/** Packages that use the hoisted version */
	hoistedBy: string[];
	/** Other versions that need to be nested */
	nestedVersions: Array<{
		version: string;
		nestedUnder: string[];
	}>;
}

/** Installation result for a single package */
export interface InstallResult {
	name: string;
	version: string;
	path: string;
}

/** Options passed to the install function */
export interface InstallOptions {
	/** Path to per-project node_modules directory */
	nodeModulesPath: string;
	/** Project name for lockfile */
	projectName: string;
}

/** Stats from an installation */
export interface InstallStats {
	resolved: number;
	downloaded: number;
	cached: number;
	failed: number;
	/** Optional dependencies that failed to install (non-fatal) */
	skipped: number;
	totalTime: number;
}

/** Lockfile structure (simplified package-lock.json) */
export interface Lockfile {
	name: string;
	lockfileVersion: number;
	packages: Record<string, LockfileEntry>;
}

export interface LockfileEntry {
	version: string;
	resolved: string;
	integrity: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, PeerDependencyMeta>;
	optional?: boolean;
}

/** Global store path where all packages are extracted (shared across projects) */
export const GLOBAL_STORE_PATH = "/.store";

/** Configuration for the installer */
export interface InstallerConfig {
	/** Path to per-project node_modules directory (e.g., "/projects/greeter/node_modules") */
	nodeModulesPath: string;
	/** Path to the global package store (e.g., "/.store") */
	storePath: string;
	/** npm registry URL */
	registry: string;
	/** Maximum concurrent downloads */
	concurrency: number;
	/** Maximum dependency depth (prevent infinite recursion) */
	maxDepth: number;
}

export const DEFAULT_CONFIG: InstallerConfig = {
	nodeModulesPath: "./node_modules",
	storePath: GLOBAL_STORE_PATH,
	registry: "https://registry.npmjs.org",
	concurrency: 10,
	maxDepth: 20,
};

/** Events emitted during installation */
export type InstallEvent =
	| { type: "resolving"; spec: string }
	| { type: "resolved"; package: ResolvedPackage }
	| { type: "downloading"; package: ResolvedPackage }
	| { type: "downloaded"; package: ResolvedPackage }
	| { type: "extracting"; package: ResolvedPackage }
	| { type: "extracted"; package: ResolvedPackage; path: string }
	| { type: "stored"; package: ResolvedPackage; storePath: string }
	| {
			type: "linking";
			name: string;
			version: string;
			linkPath: string;
			isNested: boolean;
	  }
	| { type: "linked"; name: string; version: string; linkPath: string }
	| {
			type: "conflict";
			packageName: string;
			hoistedVersion: string;
			nestedVersions: string[];
	  }
	| { type: "skipped"; name: string; reason: string }
	| {
			type: "peer_auto_install";
			name: string;
			version: string;
			requiredBy: string;
	  }
	| {
			type: "peer_warning";
			name: string;
			requiredRange: string;
			installedVersion: string | null;
			requiredBy: string;
	  }
	| { type: "error"; package?: ResolvedPackage; error: Error };

export type EventHandler = (event: InstallEvent) => void;

export type InstallFn = (
	obsFs: InstallFileSystem,
	baseFs: InstallFileSystem,
	packages: string[],
	options: InstallOptions,
) => Promise<InstallResult[]>;
