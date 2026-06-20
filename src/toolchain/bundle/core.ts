/**
 * Core bundler functions that work with any esbuild implementation
 *
 * These functions accept an esbuild API instance as a parameter,
 * allowing them to work with both native esbuild and esbuild-wasm.
 */

import { isAbsolute, resolve } from "../util";
import { buildNativeDependencySummary } from "./builtins";
import type { BundleFileSystem } from "./fs";
import {
	createFileSystemPlugin,
	createNativeImportTracker,
	createResolveCache,
	type NativeImportTracker,
	type ResolveCache,
} from "./plugin";
import type {
	BundleArgs,
	BundleFn,
	BundleOptions,
	BundleResolutionPreset,
	BundleResult,
	EsbuildAPI,
	ResolvedBundleOptions,
	ResolvedResolutionPolicy,
	VirtualFileMap,
} from "./types";
import { DEFAULT_BUNDLE_OPTIONS } from "./types";

function inferResolutionPreset(
	platform: ResolvedBundleOptions["platform"],
): BundleResolutionPreset {
	return platform === "node" ? "executable-node" : "executable-browser";
}

function resolveResolutionPolicy(
	platform: ResolvedBundleOptions["platform"],
	factoryDefaults?: BundleOptions["resolution"],
	invocationOverrides?: BundleOptions["resolution"],
): ResolvedResolutionPolicy {
	const preset =
		invocationOverrides?.preset ??
		factoryDefaults?.preset ??
		inferResolutionPreset(platform);

	const presetDefaults: Record<
		BundleResolutionPreset,
		Omit<ResolvedResolutionPolicy, "preset">
	> = {
		"executable-browser": {
			missingBareImports: "error",
			nodeBuiltins: "error",
			allowedExternals: [],
		},
		"executable-node": {
			missingBareImports: "error",
			nodeBuiltins: "external",
			allowedExternals: [],
		},
		library: {
			missingBareImports: "external",
			nodeBuiltins: "external",
			allowedExternals: [],
		},
	};

	return {
		preset,
		...presetDefaults[preset],
		...factoryDefaults,
		...invocationOverrides,
		allowedExternals: [
			...presetDefaults[preset].allowedExternals,
			...(factoryDefaults?.allowedExternals ?? []),
			...(invocationOverrides?.allowedExternals ?? []),
		],
	};
}

export function resolveBundleOptions(
	factoryDefaults?: BundleOptions,
	invocationOverrides?: BundleOptions,
): ResolvedBundleOptions {
	const platform =
		invocationOverrides?.platform ??
		factoryDefaults?.platform ??
		DEFAULT_BUNDLE_OPTIONS.platform;

	return {
		...DEFAULT_BUNDLE_OPTIONS,
		...factoryDefaults,
		...invocationOverrides,
		platform,
		resolution: resolveResolutionPolicy(
			platform,
			factoryDefaults?.resolution,
			invocationOverrides?.resolution,
		),
	};
}

export function createBundleFn(
	esbuild: EsbuildAPI,
	options?: BundleOptions,
): BundleFn {
	return async (args: BundleArgs) =>
		bundleWithEsbuild(esbuild, {
			fs: args.fs,
			entryPoint: args.entryPoint,
			entryResolveDir: args.entryResolveDir,
			packageResolveDir: args.packageResolveDir,
			virtualFiles: args.virtualFiles,
			options: resolveBundleOptions(options, args.options),
		});
}

function normalizeVirtualFiles(
	virtualFiles: VirtualFileMap | undefined,
	entryResolveDir: string,
): VirtualFileMap | undefined {
	if (!virtualFiles) return undefined;

	const normalized: VirtualFileMap = {};
	for (const [path, file] of Object.entries(virtualFiles)) {
		const normalizedPath = isAbsolute(path) ? path : resolve(entryResolveDir, path);
		normalized[normalizedPath] = file;
	}
	return normalized;
}

export interface PreparedBuild {
	/** esbuild build options, ready for `build()` or `context()`. */
	buildOptions: Parameters<EsbuildAPI["build"]>[0];
	/**
	 * Tracker the filesystem plugin populates during each (re)build. It resets
	 * itself at the start of every build, so reading it right after a build/
	 * rebuild reflects only that build.
	 */
	nativeTracker: NativeImportTracker;
	/**
	 * Resolution cache shared with the filesystem plugin. The one-shot path
	 * ignores it (a fresh cache per call); a {@link BundleSession} keeps it to
	 * retain resolutions across rebuilds and invalidate them on notification.
	 */
	resolveCache: ResolveCache;
}

/**
 * Build the esbuild options (and native-import tracker) shared by the one-shot
 * {@link bundleWithEsbuild} and the persistent bundle session. Installs the
 * filesystem plugin and resolves the entry point against `entryResolveDir`.
 */
export function prepareBuild(args: {
	fs: BundleFileSystem;
	entryPoint: string;
	entryResolveDir: string;
	packageResolveDir?: string;
	virtualFiles?: VirtualFileMap;
	options: ResolvedBundleOptions;
}): PreparedBuild {
	const { fs, options, packageResolveDir = args.entryResolveDir } = args;
	const entryPoint = isAbsolute(args.entryPoint)
		? args.entryPoint
		: resolve(args.entryResolveDir, args.entryPoint);
	const virtualFiles = normalizeVirtualFiles(
		args.virtualFiles,
		args.entryResolveDir,
	);

	const nativeTracker = createNativeImportTracker();
	const resolveCache = createResolveCache();

	const buildOptions: Parameters<EsbuildAPI["build"]>[0] = {
		entryPoints: [entryPoint],
		bundle: true,
		write: false,
		format: options.format,
		platform: options.platform,
		minify: options.minify,
		sourcemap: options.sourcemap,
		target: options.target,
		external: options.external,
		define: options.define,
		inject: options.inject,
		alias: options.alias,
		jsx: "automatic",
		plugins: [
			createFileSystemPlugin(
				fs,
				{
					entryResolveDir: args.entryResolveDir,
					packageResolveDir,
					resolution: options.resolution,
					virtualFiles,
				},
				nativeTracker,
				resolveCache,
			),
		],
		metafile: true,
		logLevel: "silent",
	};

	// esbuild needs an output *path* to name and emit a separate CSS output file
	// when a JS/TS module imports a `.css` (otherwise it refuses with "Cannot
	// import ... into a JavaScript file without an output path configured"). This
	// is a naming concern, not a write target — `write` is false, so nothing ever
	// touches the fs; the bundled CSS comes back via `outputFiles` and is split
	// out by `extractResult`. Honor an explicit `outfile` (e.g. for linked
	// sourcemaps); otherwise default a synthetic `outdir` so CSS imports work out
	// of the box. esbuild rejects `outfile` and `outdir` together, so it's one or
	// the other.
	if (options.outfile) {
		buildOptions.outfile = options.outfile;
	} else {
		buildOptions.outdir = "/";
	}

	return { buildOptions, nativeTracker, resolveCache };
}

/**
 * Turn an esbuild build/rebuild result into a {@link BundleResult}, splitting
 * output files into JS/CSS/maps and summarizing native dependencies from the
 * plugin's tracker.
 */
export function extractResult(
	result: Awaited<ReturnType<EsbuildAPI["build"]>>,
	nativeTracker: NativeImportTracker,
): BundleResult {
	let code = "";
	let css: string | undefined;
	let map: string | undefined;
	let cssMap: string | undefined;

	for (const file of result.outputFiles || []) {
		const path = file.path;
		const content = new TextDecoder().decode(file.contents);

		if (path.endsWith(".css.map")) {
			cssMap = content;
		} else if (path.endsWith(".css")) {
			css = content;
		} else if (path.endsWith(".map")) {
			map = content;
		} else {
			// JavaScript output
			code = content;
		}
	}

	const inputs = result.metafile ? Object.keys(result.metafile.inputs) : [];
	const graph = buildGraph(result.metafile);
	const nativeDependencies = buildNativeDependencySummary(
		nativeTracker.getImports(),
	);

	return {
		code,
		css,
		map,
		cssMap,
		warnings: result.warnings,
		inputs,
		graph,
		nativeDependencies,
	};
}

/**
 * Strip esbuild's plugin namespace prefix (`fs:`) so paths are plain absolute
 * VFS paths the render runtime and HMR layer can use as registry keys.
 */
function stripNamespace(path: string): string {
	return path.startsWith("fs:") ? path.slice("fs:".length) : path;
}

/**
 * Build the {@link BundleGraph} from esbuild's metafile: one entry per input,
 * each carrying its outgoing import edges with both the written specifier
 * (`original`) and the resolved absolute path, namespace-stripped.
 */
function buildGraph(
	metafile: Awaited<ReturnType<EsbuildAPI["build"]>>["metafile"],
): BundleResult["graph"] {
	const graph: BundleResult["graph"] = {};
	if (!metafile) return graph;
	for (const [key, input] of Object.entries(metafile.inputs)) {
		graph[stripNamespace(key)] = {
			imports: input.imports.map((imp) => ({
				path: stripNamespace(imp.path),
				...(imp.original !== undefined ? { original: imp.original } : {}),
			})),
		};
	}
	return graph;
}

/**
 * Bundle code from a BundleFileSystem using a provided esbuild API
 *
 * @param esbuildApi - The esbuild API to use (native or wasm)
 * @param args - Bundle inputs and resolution directories
 * @returns The bundled code and metadata
 */
export async function bundleWithEsbuild(
	esbuildApi: EsbuildAPI,
	args: {
		fs: BundleFileSystem;
		entryPoint: string;
		entryResolveDir: string;
		packageResolveDir?: string;
		virtualFiles?: VirtualFileMap;
		options: ResolvedBundleOptions;
	},
): Promise<BundleResult> {
	const { buildOptions, nativeTracker } = prepareBuild(args);
	const result = await esbuildApi.build(buildOptions);
	return extractResult(result, nativeTracker);
}
