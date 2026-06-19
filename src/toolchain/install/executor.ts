/**
 * Installer - extracts packages to store and creates symlinks
 *
 * This handles the "execution" phase after resolution:
 * 1. Extract packages to global store at {storePath}/{name}/{version}/node_modules/{name}/
 * 2. Create dependency links between packages in the global store (inter-package resolution)
 * 3. Create hoisted links from per-project node_modules to the global store
 *
 * This enables Node.js runtime resolution of inter-package dependencies.
 */

import { join } from "../util";
import type { InstallFileSystem } from "./fs";
import {
	createDependencyLink,
	createLink,
	ensureStore,
	extractToStore,
	isInStore,
} from "./store";
import type {
	EventHandler,
	InstallerConfig,
	InstallPlan,
	InstallStats,
	StorePackage,
} from "./types";

/** Result of installing a single package to store */
type StoreResultType = "extracted" | "exists" | "failed" | "skipped";

export interface InstallOptions {
	config: InstallerConfig;
	fs: InstallFileSystem;
	onEvent?: EventHandler;
}

/**
 * A simple async queue with concurrency control
 */
class AsyncQueue<T, R> {
	private queue: T[] = [];
	private running = 0;
	private readonly concurrency: number;
	private readonly processor: (item: T) => Promise<R>;
	private results: R[] = [];
	private resolveAll?: () => void;

	constructor(concurrency: number, processor: (item: T) => Promise<R>) {
		this.concurrency = concurrency;
		this.processor = processor;
	}

	add(item: T): void {
		this.queue.push(item);
	}

	addAll(items: T[]): void {
		this.queue.push(...items);
	}

	async run(): Promise<R[]> {
		// Handle empty queue case
		if (this.queue.length === 0) {
			return this.results;
		}

		return new Promise((resolve) => {
			this.resolveAll = () => resolve(this.results);
			// Start initial batch of workers
			const initialBatch = Math.min(this.concurrency, this.queue.length);
			for (let i = 0; i < initialBatch; i++) {
				this.processNext();
			}
		});
	}

	private async processNext(): Promise<void> {
		if (this.queue.length === 0) {
			// No more items, check if we're done
			if (this.running === 0 && this.resolveAll) {
				this.resolveAll();
			}
			return;
		}

		const item = this.queue.shift();
		if (item === undefined) return;
		this.running++;

		try {
			const result = await this.processor(item);
			this.results.push(result);
		} catch {
			// Processor should handle its own errors
		}

		this.running--;
		// Process next item
		this.processNext();
	}
}

/**
 * Execute an install plan: extract to store and create symlinks
 *
 * Three phases:
 * 1. Extract packages to the global store (parallel downloads)
 * 2. Create dependency links (inter-package symlinks in the global store)
 * 3. Create hoisted links (per-project node_modules symlinks)
 */
export async function executeInstallPlan(
	plan: InstallPlan,
	options: InstallOptions,
): Promise<InstallStats> {
	const { config, fs, onEvent } = options;
	const startTime = Date.now();

	// Ensure per-project node_modules and global store directories exist
	await fs.mkdir(config.nodeModulesPath, { recursive: true });
	await ensureStore(fs, config.storePath);

	const storePackages = Array.from(plan.storePackages.values());

	if (storePackages.length === 0) {
		return {
			resolved: 0,
			downloaded: 0,
			cached: 0,
			failed: 0,
			skipped: 0,
			totalTime: Date.now() - startTime,
		};
	}

	// =========================================================================
	// Phase 1: Extract packages to the global store (parallel)
	// =========================================================================
	const storeProcessor = async (sp: StorePackage): Promise<StoreResultType> => {
		try {
			// Check if already in global store
			if (
				await isInStore(
					fs,
					config.storePath,
					sp.package.name,
					sp.package.version,
				)
			) {
				onEvent?.({
					type: "stored",
					package: sp.package,
					storePath: sp.storePath,
				});
				return "exists";
			}

			// Extract to global store
			await extractToStore(
				fs,
				sp.package,
				config.storePath,
				config.registry,
				onEvent,
			);
			return "extracted";
		} catch (error) {
			// For optional dependencies, failures are not fatal
			if (sp.package.isOptional) {
				onEvent?.({
					type: "skipped",
					name: sp.package.name,
					reason: `optional dependency failed: ${error instanceof Error ? error.message : String(error)}`,
				});
				return "skipped";
			}

			onEvent?.({
				type: "error",
				package: sp.package,
				error: error instanceof Error ? error : new Error(String(error)),
			});
			return "failed";
		}
	};

	const storeQueue = new AsyncQueue<StorePackage, StoreResultType>(
		config.concurrency,
		storeProcessor,
	);
	storeQueue.addAll(storePackages);
	const storeResults = await storeQueue.run();

	// =========================================================================
	// Phase 2: Create dependency links (inter-package symlinks in global store)
	// =========================================================================
	let depLinksFailed = 0;

	for (const sp of storePackages) {
		for (const depLink of sp.dependencyLinks) {
			try {
				const targetPkg = plan.storePackages.get(depLink.targetKey);
				if (!targetPkg) {
					// Target package not found (might have been skipped as optional)
					continue;
				}

				await createDependencyLink(
					fs,
					depLink,
					sp.storePath,
					targetPkg.storePath,
				);
			} catch {
				// Log but don't fail - some deps might be optional
				depLinksFailed++;
			}
		}
	}

	// =========================================================================
	// Phase 3: Create hoisted links (per-project node_modules symlinks)
	// =========================================================================
	// IMPORTANT: Sort links so hoisted links are created before nested links.
	// Nested links (like node_modules/debug/node_modules/ms) depend on their
	// parent symlinks (node_modules/debug) existing first.
	const sortedLinks = [...plan.links].sort((a, b) => {
		// Hoisted (isNested=false) comes before nested (isNested=true)
		if (a.isNested !== b.isNested) {
			return a.isNested ? 1 : -1;
		}
		// Within the same category, shorter paths first (parents before children)
		return a.linkPath.length - b.linkPath.length;
	});

	let linksFailed = 0;

	for (const link of sortedLinks) {
		try {
			await createLink(fs, link, onEvent);
		} catch (error) {
			onEvent?.({
				type: "error",
				error: error instanceof Error ? error : new Error(String(error)),
			});
			linksFailed++;
		}
	}

	// Count results
	const extracted = storeResults.filter((r) => r === "extracted").length;
	const exists = storeResults.filter((r) => r === "exists").length;
	const failed = storeResults.filter((r) => r === "failed").length;
	const skipped = storeResults.filter((r) => r === "skipped").length;

	return {
		resolved: plan.storePackages.size,
		downloaded: extracted,
		cached: exists, // "cached" now means "already in store"
		failed: failed + linksFailed + depLinksFailed,
		skipped,
		totalTime: Date.now() - startTime,
	};
}

/**
 * Check if a package is already installed at the expected version
 */
export async function isPackageInstalled(
	fs: InstallFileSystem,
	name: string,
	version: string,
	nodeModulesPath: string,
): Promise<boolean> {
	const pkgJsonPath = join(nodeModulesPath, name, "package.json");

	try {
		const content = await fs.readFile(pkgJsonPath);
		const pkgJson = JSON.parse(content);
		return pkgJson.version === version;
	} catch {
		return false;
	}
}
