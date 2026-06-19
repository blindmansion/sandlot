/**
 * Persistent, incremental bundling session.
 *
 * Holds a long-lived esbuild `BuildContext` bound to a fixed entry point and
 * filesystem. esbuild keeps its parsed/linked graph in memory, so each
 * `rebuild()` only re-parses inputs whose contents actually changed — the
 * editor-loop analog of the one-shot `createBundleFn`.
 *
 * Module *content* is re-read on every rebuild (the plugin's `onLoad` runs each
 * time, leaving content caching to the filesystem backing), but module
 * *resolution* (stat probes, parsed package.json, bare-import decisions) is
 * cached across rebuilds. To keep that cache correct, callers mutate the
 * filesystem and then notify the session what changed
 * (`changed`/`created`/`deleted`, or `invalidate()` after an install): un-notified
 * structural mutations yield stale resolution. Pure content edits to an existing,
 * already-resolved file need no notification — `onLoad` re-reads them. Always
 * `dispose()` when finished to release the underlying build context.
 */

import type * as esbuild from "esbuild-wasm";
import { basename } from "../util";
import { extractResult, prepareBuild, resolveBundleOptions } from "./core";
import type { NativeImportTracker, ResolveCache } from "./plugin";
import type {
	BundleArgs,
	BundleOptions,
	BundleResult,
	BundleSession,
	EsbuildAPI,
} from "./types";

/**
 * A change under `node_modules/` or to any `package.json` can shift bare-import
 * decisions and parsed manifests (both memoized), so it forces a full cache
 * reset rather than a single-path invalidation.
 */
function isNodeModulesOrManifest(path: string): boolean {
	if (path.includes("/node_modules/")) return true;
	return basename(path) === "package.json";
}

class Session implements BundleSession {
	private readonly ctx: esbuild.BuildContext;
	private readonly nativeTracker: NativeImportTracker;
	private readonly resolveCache: ResolveCache;
	/** Serializes overlapping rebuild() calls; esbuild allows one at a time. */
	private queue: Promise<unknown> = Promise.resolve();
	private disposed = false;

	constructor(
		ctx: esbuild.BuildContext,
		nativeTracker: NativeImportTracker,
		resolveCache: ResolveCache,
	) {
		this.ctx = ctx;
		this.nativeTracker = nativeTracker;
		this.resolveCache = resolveCache;
	}

	rebuild(): Promise<BundleResult> {
		if (this.disposed) {
			return Promise.reject(new Error("BundleSession has been disposed"));
		}
		// Chain regardless of whether the previous rebuild settled or threw, so a
		// failed rebuild doesn't wedge the queue. Each caller still observes its
		// own rebuild's result/error.
		const result = this.queue.then(
			() => this.runRebuild(),
			() => this.runRebuild(),
		);
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async runRebuild(): Promise<BundleResult> {
		const result = await this.ctx.rebuild();
		return extractResult(result, this.nativeTracker);
	}

	changed(path: string): void {
		this.notify(path);
	}

	created(path: string): void {
		this.notify(path);
	}

	deleted(path: string): void {
		this.notify(path);
	}

	invalidate(): void {
		this.resolveCache.markFullReset();
	}

	/**
	 * Queue a resolution-cache invalidation for the next rebuild. Synchronous: no
	 * I/O happens here (contents are re-read lazily during `rebuild()`), so we
	 * only record which cached resolutions to drop. A `node_modules`/`package.json`
	 * path forces a full reset; any other path drops only its `stat` entry, which
	 * is enough because the resolver re-probes the exact candidate and recomputes
	 * relative resolutions from it.
	 */
	private notify(path: string): void {
		if (isNodeModulesOrManifest(path)) {
			this.resolveCache.markFullReset();
		} else {
			this.resolveCache.markDirty(path);
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.ctx.dispose();
	}
}

/**
 * Create a stateful, incremental bundling session.
 *
 * @param esbuild - The esbuild API to use (native or wasm)
 * @param args - Bundle inputs and resolution directories (fixed for the session)
 * @param factoryDefaults - Default options merged under `args.options`
 *
 * @example
 * ```ts
 * const session = await createBundleSession(esbuild, {
 *   fs, entryPoint: "/src/index.ts", entryResolveDir: "/",
 * });
 * const first = await session.rebuild();   // cold: builds the graph
 * await fs.writeFile("/src/index.ts", next);
 * session.changed("/src/index.ts");        // notify after mutating the fs
 * const again = await session.rebuild();   // warm: reuses cached parse + resolution
 * await session.dispose();
 * ```
 */
export async function createBundleSession(
	esbuild: EsbuildAPI,
	args: BundleArgs,
	factoryDefaults?: BundleOptions,
): Promise<BundleSession> {
	const { buildOptions, nativeTracker, resolveCache } = prepareBuild({
		fs: args.fs,
		entryPoint: args.entryPoint,
		entryResolveDir: args.entryResolveDir,
		packageResolveDir: args.packageResolveDir,
		virtualFiles: args.virtualFiles,
		options: resolveBundleOptions(factoryDefaults, args.options),
	});

	const ctx = await esbuild.context(buildOptions);
	return new Session(ctx, nativeTracker, resolveCache);
}
