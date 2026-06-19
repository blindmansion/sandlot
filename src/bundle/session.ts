/**
 * Persistent, incremental bundling session.
 *
 * Holds a long-lived esbuild `BuildContext` bound to a fixed entry point and
 * filesystem. esbuild keeps its parsed/linked graph in memory, so each
 * `rebuild()` only re-parses inputs whose contents actually changed — the
 * editor-loop analog of the one-shot `createBundleFn`.
 *
 * The session re-reads the filesystem on every rebuild (the plugin's resolve and
 * load callbacks run each time), so callers just mutate the filesystem and call
 * `rebuild()`; there are no change notifications to send. Always `dispose()` when
 * finished to release the underlying build context.
 */

import type * as esbuild from "esbuild-wasm";
import { extractResult, prepareBuild, resolveBundleOptions } from "./core";
import type { NativeImportTracker } from "./plugin";
import type {
	BundleArgs,
	BundleOptions,
	BundleResult,
	BundleSession,
	EsbuildAPI,
} from "./types";

class Session implements BundleSession {
	private readonly ctx: esbuild.BuildContext;
	private readonly nativeTracker: NativeImportTracker;
	/** Serializes overlapping rebuild() calls; esbuild allows one at a time. */
	private queue: Promise<unknown> = Promise.resolve();
	private disposed = false;

	constructor(ctx: esbuild.BuildContext, nativeTracker: NativeImportTracker) {
		this.ctx = ctx;
		this.nativeTracker = nativeTracker;
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
 * const again = await session.rebuild();   // warm: reuses cached parse
 * await session.dispose();
 * ```
 */
export async function createBundleSession(
	esbuild: EsbuildAPI,
	args: BundleArgs,
	factoryDefaults?: BundleOptions,
): Promise<BundleSession> {
	const { buildOptions, nativeTracker } = prepareBuild({
		fs: args.fs,
		entryPoint: args.entryPoint,
		entryResolveDir: args.entryResolveDir,
		packageResolveDir: args.packageResolveDir,
		virtualFiles: args.virtualFiles,
		options: resolveBundleOptions(factoryDefaults, args.options),
	});

	const ctx = await esbuild.context(buildOptions);
	return new Session(ctx, nativeTracker);
}
