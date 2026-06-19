/**
 * Dependency resolver - builds the complete dependency tree and install plan
 *
 * This is the "planning" phase of installation:
 * 1. Start with requested packages
 * 2. Recursively resolve all dependencies, tracking ALL version requirements
 * 3. Detect version conflicts (same package, different versions needed)
 * 4. Decide which versions to hoist vs nest
 * 5. Output an InstallPlan with store packages and symlink entries
 */

import { satisfies } from "semver";
import { createSpec, fetchManifest } from "./registry";
import { getPackageStorePath } from "./store";
import type {
	DependencyLink,
	DependencyNode,
	EventHandler,
	InstallerConfig,
	InstallPlan,
	LinkEntry,
	ResolvedPackage,
	StorePackage,
	VersionConflict,
	VersionRequirement,
} from "./types";

/** Tracks a peer dependency requirement */
export interface PeerDepRequirement {
	/** The package that requires the peer dep */
	requiredBy: string;
	/** The peer dep name */
	peerName: string;
	/** The required version range */
	peerVersionRange: string;
	/** Whether this peer dep is optional */
	isOptional: boolean;
}

export interface ResolverResult {
	/** The dependency tree (for visualization) */
	tree: DependencyNode;
	/** The install plan (for the installer) */
	plan: InstallPlan;
	/** Peer dependency warnings */
	peerWarnings: Array<{
		name: string;
		requiredRange: string;
		installedVersion: string | null;
		requiredBy: string;
	}>;
	/** Stats */
	stats: {
		totalResolved: number;
		uniquePackages: number;
		duplicatesSkipped: number;
		maxDepth: number;
		peerDepsAutoInstalled: number;
		conflictCount: number;
	};
}

/**
 * Internal state for tracking all resolved packages and their requirements
 */
interface ResolutionState {
	/** All resolved packages: "name@version" -> ResolvedPackage */
	packages: Map<string, ResolvedPackage>;
	/** Version requirements: tracks who needs what version of each package */
	requirements: VersionRequirement[];
	/** Packages currently being resolved (circular dependency detection) */
	inProgress: Set<string>;
	/** Peer dependency requirements (processed after main resolution) */
	peerRequirements: PeerDepRequirement[];
	/** Stats */
	totalResolved: number;
	duplicatesSkipped: number;
	maxDepthSeen: number;
	peerDepsAutoInstalled: number;
}

/**
 * Get a unique key for a package@version
 */
function packageKey(name: string, version: string): string {
	return `${name}@${version}`;
}

/**
 * Resolve all dependencies for the given package specs
 */
export async function resolveDependencies(
	specs: string[],
	config: InstallerConfig,
	onEvent?: EventHandler,
): Promise<ResolverResult> {
	const state: ResolutionState = {
		packages: new Map(),
		requirements: [],
		inProgress: new Set(),
		peerRequirements: [],
		totalResolved: 0,
		duplicatesSkipped: 0,
		maxDepthSeen: 0,
		peerDepsAutoInstalled: 0,
	};

	// Peer dependency warnings
	const peerWarnings: ResolverResult["peerWarnings"] = [];

	/**
	 * Recursively resolve a single package and its dependencies.
	 * Unlike before, we track ALL version requirements, not just the first.
	 */
	async function resolvePackage(
		spec: string,
		depth: number,
		parent?: DependencyNode,
		dependentName: string = "__root__",
		isOptional: boolean = false,
	): Promise<DependencyNode | null> {
		state.maxDepthSeen = Math.max(state.maxDepthSeen, depth);

		if (depth > config.maxDepth) {
			onEvent?.({
				type: "skipped",
				name: spec,
				reason: `max depth (${config.maxDepth}) exceeded`,
			});
			return null;
		}

		onEvent?.({ type: "resolving", spec });

		// Fetch manifest from registry
		let pkg: ResolvedPackage;
		try {
			pkg = await fetchManifest(spec, { registry: config.registry });
		} catch (error) {
			// For optional dependencies, failures are not fatal
			if (isOptional) {
				onEvent?.({
					type: "skipped",
					name: spec,
					reason: `optional dependency failed to resolve: ${error instanceof Error ? error.message : String(error)}`,
				});
				return null;
			}
			onEvent?.({
				type: "error",
				error: error instanceof Error ? error : new Error(String(error)),
			});
			return null;
		}

		// Mark the package as optional if it was required as such
		if (isOptional) {
			pkg = { ...pkg, isOptional: true };
		}

		state.totalResolved++;
		onEvent?.({ type: "resolved", package: pkg });

		const key = packageKey(pkg.name, pkg.version);

		// Check for circular dependencies (in progress)
		if (state.inProgress.has(pkg.name)) {
			onEvent?.({
				type: "skipped",
				name: pkg.name,
				reason: "circular dependency",
			});
			return null;
		}

		// Record this version requirement
		state.requirements.push({
			dependentName,
			dependencyName: pkg.name,
			versionRange: spec.split("@").pop() ?? "latest",
			resolvedVersion: pkg.version,
			isOptional,
		});

		// Check if we already have this exact version
		const existingExact = state.packages.get(key);
		if (existingExact) {
			state.duplicatesSkipped++;
			onEvent?.({
				type: "skipped",
				name: pkg.name,
				reason: `already resolved ${pkg.name}@${pkg.version}`,
			});

			// Return a node referencing the existing package
			return {
				package: existingExact,
				dependencies: new Map(),
				parent,
				depth,
			};
		}

		// Mark as in-progress
		state.inProgress.add(pkg.name);

		// Add to packages map
		state.packages.set(key, pkg);

		// Create node
		const node: DependencyNode = {
			package: pkg,
			dependencies: new Map(),
			parent,
			depth,
		};

		// Resolve all regular dependencies
		for (const dep of pkg.dependencies) {
			const depSpec = createSpec(dep.name, dep.versionRange);
			const depNode = await resolvePackage(
				depSpec,
				depth + 1,
				node,
				pkg.name,
				false,
			);
			if (depNode) {
				node.dependencies.set(dep.name, depNode);
			}
		}

		// Resolve all optional dependencies
		for (const dep of pkg.optionalDependencies) {
			const depSpec = createSpec(dep.name, dep.versionRange);
			const depNode = await resolvePackage(
				depSpec,
				depth + 1,
				node,
				pkg.name,
				true,
			);
			if (depNode) {
				node.dependencies.set(dep.name, depNode);
			}
		}

		// Collect peer dependency requirements (will be processed after main resolution)
		for (const peer of pkg.peerDependencies) {
			const isOptionalPeer =
				pkg.peerDependenciesMeta[peer.name]?.optional === true;
			state.peerRequirements.push({
				requiredBy: pkg.name,
				peerName: peer.name,
				peerVersionRange: peer.versionRange,
				isOptional: isOptionalPeer,
			});
		}

		// Remove from in-progress
		state.inProgress.delete(pkg.name);

		return node;
	}

	// Create a virtual root node for multiple entry specs
	const rootPkg: ResolvedPackage = {
		name: "__root__",
		version: "0.0.0",
		dependencies: specs.map((s) => {
			const parts = s.split("@");
			// Handle scoped packages: @scope/name@version
			const name = s.startsWith("@") ? `@${parts[1] || ""}` : parts[0] || s;
			const version = s.startsWith("@")
				? parts[2] || "latest"
				: parts[1] || "latest";
			return { name, versionRange: version };
		}),
		optionalDependencies: [],
		peerDependencies: [],
		peerDependenciesMeta: {},
		integrity: "",
		tarballUrl: "",
		resolved: "",
	};

	const rootNode: DependencyNode = {
		package: rootPkg,
		dependencies: new Map(),
		depth: -1,
	};

	// Resolve each requested package
	for (const spec of specs) {
		const node = await resolvePackage(spec, 0, rootNode, "__root__");
		if (node) {
			rootNode.dependencies.set(node.package.name, node);
		}
	}

	// Process peer dependencies (npm 7+ style: auto-install missing peers)
	const peersByName = new Map<string, PeerDepRequirement[]>();
	for (const req of state.peerRequirements) {
		const existing = peersByName.get(req.peerName) || [];
		existing.push(req);
		peersByName.set(req.peerName, existing);
	}

	for (const [peerName, requirements] of peersByName) {
		// Check if any version of this peer is already installed
		const installedVersions = Array.from(state.packages.values()).filter(
			(p) => p.name === peerName,
		);

		const firstInstalled = installedVersions[0];
		if (firstInstalled) {
			// Validate version compatibility for each requirement
			for (const req of requirements) {
				const compatible = installedVersions.some((p) =>
					satisfies(p.version, req.peerVersionRange),
				);
				if (!compatible) {
					peerWarnings.push({
						name: peerName,
						requiredRange: req.peerVersionRange,
						installedVersion: firstInstalled.version,
						requiredBy: req.requiredBy,
					});
					onEvent?.({
						type: "peer_warning",
						name: peerName,
						requiredRange: req.peerVersionRange,
						installedVersion: firstInstalled.version,
						requiredBy: req.requiredBy,
					});
				}
			}
		} else {
			// Peer dep not installed - check if all requirements are optional
			const allOptional = requirements.every((r) => r.isOptional);

			if (allOptional) {
				onEvent?.({
					type: "skipped",
					name: peerName,
					reason: `optional peer dependency not installed`,
				});
			} else {
				// At least one requirement is not optional - auto-install
				const primaryReq =
					requirements.find((r) => !r.isOptional) ?? requirements[0];
				if (!primaryReq) continue;

				onEvent?.({
					type: "peer_auto_install",
					name: peerName,
					version: primaryReq.peerVersionRange,
					requiredBy: primaryReq.requiredBy,
				});

				const peerSpec = createSpec(peerName, primaryReq.peerVersionRange);
				const peerNode = await resolvePackage(
					peerSpec,
					0,
					rootNode,
					primaryReq.requiredBy,
					false,
				);

				if (peerNode) {
					rootNode.dependencies.set(peerName, peerNode);
					state.peerDepsAutoInstalled++;

					// Check if the auto-installed version satisfies all requirements
					for (const req of requirements) {
						if (!satisfies(peerNode.package.version, req.peerVersionRange)) {
							peerWarnings.push({
								name: peerName,
								requiredRange: req.peerVersionRange,
								installedVersion: peerNode.package.version,
								requiredBy: req.requiredBy,
							});
							onEvent?.({
								type: "peer_warning",
								name: peerName,
								requiredRange: req.peerVersionRange,
								installedVersion: peerNode.package.version,
								requiredBy: req.requiredBy,
							});
						}
					}
				} else {
					peerWarnings.push({
						name: peerName,
						requiredRange: primaryReq.peerVersionRange,
						installedVersion: null,
						requiredBy: primaryReq.requiredBy,
					});
					onEvent?.({
						type: "peer_warning",
						name: peerName,
						requiredRange: primaryReq.peerVersionRange,
						installedVersion: null,
						requiredBy: primaryReq.requiredBy,
					});
				}
			}
		}
	}

	// Build the install plan
	const plan = buildInstallPlan(state, config, onEvent);

	return {
		tree: rootNode,
		plan,
		peerWarnings,
		stats: {
			totalResolved: state.totalResolved,
			uniquePackages: state.packages.size,
			duplicatesSkipped: state.duplicatesSkipped,
			maxDepth: state.maxDepthSeen,
			peerDepsAutoInstalled: state.peerDepsAutoInstalled,
			conflictCount: plan.conflicts.length,
		},
	};
}

/**
 * Build the install plan from the resolution state.
 * This determines which versions to hoist and which to nest.
 * Also populates dependencyLinks for each package (pnpm-style).
 */
function buildInstallPlan(
	state: ResolutionState,
	config: InstallerConfig,
	onEvent?: EventHandler,
): InstallPlan {
	const { nodeModulesPath, storePath: globalStorePath } = config;

	// Group packages by name to find conflicts
	const packagesByName = new Map<string, ResolvedPackage[]>();
	for (const pkg of state.packages.values()) {
		const existing = packagesByName.get(pkg.name) || [];
		existing.push(pkg);
		packagesByName.set(pkg.name, existing);
	}

	// Group requirements by dependency name
	const requirementsByDep = new Map<string, VersionRequirement[]>();
	for (const req of state.requirements) {
		const existing = requirementsByDep.get(req.dependencyName) || [];
		existing.push(req);
		requirementsByDep.set(req.dependencyName, existing);
	}

	const storePackages = new Map<string, StorePackage>();
	const links: LinkEntry[] = [];
	const conflicts: VersionConflict[] = [];

	// First pass: Add all versions to the store (with empty dependencyLinks)
	// Store paths use the global store, not per-project node_modules
	for (const [, versions] of packagesByName) {
		for (const pkg of versions) {
			const key = packageKey(pkg.name, pkg.version);
			const pkgStorePath = getPackageStorePath(
				globalStorePath,
				pkg.name,
				pkg.version,
			);
			storePackages.set(key, {
				package: pkg,
				storePath: pkgStorePath,
				dependencyLinks: [], // Will be populated in second pass
			});
		}
	}

	// Helper function to find the resolved version of a dependency
	// based on which version was actually resolved for the given range
	function findResolvedVersion(
		depName: string,
		versionRange: string,
	): string | null {
		const versions = packagesByName.get(depName);
		if (!versions) return null;

		// Find a version that satisfies the range
		for (const pkg of versions) {
			if (satisfies(pkg.version, versionRange)) {
				return pkg.version;
			}
		}
		return null;
	}

	// Second pass: Populate dependencyLinks for each StorePackage
	for (const [, storePkg] of storePackages) {
		const pkg = storePkg.package;
		const depLinks: DependencyLink[] = [];

		// Add links for regular dependencies
		for (const dep of pkg.dependencies) {
			const resolvedVersion = findResolvedVersion(dep.name, dep.versionRange);
			if (resolvedVersion) {
				depLinks.push({
					name: dep.name,
					targetKey: packageKey(dep.name, resolvedVersion),
				});
			}
		}

		// Add links for optional dependencies (if they were resolved)
		for (const dep of pkg.optionalDependencies) {
			const resolvedVersion = findResolvedVersion(dep.name, dep.versionRange);
			if (resolvedVersion) {
				depLinks.push({
					name: dep.name,
					targetKey: packageKey(dep.name, resolvedVersion),
				});
			}
		}

		storePkg.dependencyLinks = depLinks;
	}

	// Third pass: Process hoisting and conflicts for top-level links
	// Store paths come from the global store; link paths are per-project
	for (const [name, versions] of packagesByName) {
		const firstVersion = versions[0];
		if (!firstVersion) continue; // Skip if no versions

		if (versions.length === 1) {
			// No conflict - just hoist
			const pkg = firstVersion;
			const pkgStorePath = getPackageStorePath(
				globalStorePath,
				pkg.name,
				pkg.version,
			);
			links.push({
				name: pkg.name,
				version: pkg.version,
				linkPath: `${nodeModulesPath}/${pkg.name}`,
				targetPath: pkgStorePath,
				isNested: false,
			});
		} else {
			// Conflict! Multiple versions of the same package
			const requirements = requirementsByDep.get(name) || [];

			// Decide which version to hoist:
			// Strategy: Pick the version that satisfies the most requirements
			const versionScores = new Map<
				string,
				{ count: number; dependents: string[] }
			>();

			for (const pkg of versions) {
				versionScores.set(pkg.version, { count: 0, dependents: [] });
			}

			for (const req of requirements) {
				for (const pkg of versions) {
					if (satisfies(pkg.version, req.versionRange)) {
						const score = versionScores.get(pkg.version);
						if (!score) continue;
						score.count++;
						if (!score.dependents.includes(req.dependentName)) {
							score.dependents.push(req.dependentName);
						}
					}
				}
			}

			// Find the version with the highest score
			let hoistedVersion = firstVersion.version;
			let hoistedScore = 0;
			let hoistedBy: string[] = [];

			for (const [version, score] of versionScores) {
				if (score.count > hoistedScore) {
					hoistedVersion = version;
					hoistedScore = score.count;
					hoistedBy = score.dependents;
				}
			}

			// Record the conflict
			const nestedVersions: VersionConflict["nestedVersions"] = [];

			for (const pkg of versions) {
				const pkgStorePath = getPackageStorePath(
					globalStorePath,
					pkg.name,
					pkg.version,
				);

				if (pkg.version === hoistedVersion) {
					// This is the hoisted version
					links.push({
						name: pkg.name,
						version: pkg.version,
						linkPath: `${nodeModulesPath}/${pkg.name}`,
						targetPath: pkgStorePath,
						isNested: false,
					});
				} else {
					// This version needs to be nested
					// Find which packages specifically need this version
					const needsThis: string[] = [];
					for (const req of requirements) {
						if (
							satisfies(pkg.version, req.versionRange) &&
							!satisfies(hoistedVersion, req.versionRange) &&
							req.dependentName !== "__root__"
						) {
							if (!needsThis.includes(req.dependentName)) {
								needsThis.push(req.dependentName);
							}
						}
					}

					// Create nested links for each package that needs this version
					for (const dependent of needsThis) {
						links.push({
							name: pkg.name,
							version: pkg.version,
							linkPath: `${nodeModulesPath}/${dependent}/node_modules/${pkg.name}`,
							targetPath: pkgStorePath,
							isNested: true,
							nestedUnder: dependent,
						});
					}

					if (needsThis.length > 0) {
						nestedVersions.push({
							version: pkg.version,
							nestedUnder: needsThis,
						});
					}
				}
			}

			if (nestedVersions.length > 0) {
				conflicts.push({
					packageName: name,
					hoistedVersion,
					hoistedBy,
					nestedVersions,
				});

				onEvent?.({
					type: "conflict",
					packageName: name,
					hoistedVersion,
					nestedVersions: nestedVersions.map((v) => v.version),
				});
			}
		}
	}

	return {
		storePackages,
		links,
		conflicts,
		stats: {
			totalPackages: storePackages.size,
			uniqueVersions: storePackages.size,
			hoistedPackages: links.filter((l) => !l.isNested).length,
			nestedPackages: links.filter((l) => l.isNested).length,
			conflictCount: conflicts.length,
		},
	};
}
