/**
 * esbuild filesystem plugin
 *
 * This plugin enables esbuild to read source files from a BundleFileSystem interface,
 * enabling bundling in the browser using InMemoryFileSystem.
 *
 * This plugin works with both native esbuild and esbuild-wasm.
 */

import type * as esbuild from "esbuild-wasm";
import {
	dirname,
	extname,
	isAbsolute,
	join,
	parsePackageSpecifier,
} from "../util";
import { isNodeBuiltin, normalizeBuiltinName } from "./builtins";
import type { BundleFileStat, BundleFileSystem } from "./fs";
import type { ResolvedResolutionPolicy, VirtualFileMap } from "./types";

// ---------- Constants ----------

/** Extensions tried when resolving a module specifier to a file */
const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"];

/** Extensions tried when looking for an index file inside a directory */
const INDEX_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];

/** Map of file extensions to esbuild loaders */
const LOADER_MAP: Record<string, esbuild.Loader> = {
	".ts": "ts",
	".tsx": "tsx",
	".jsx": "jsx",
	".json": "json",
	".css": "css",
	".mjs": "js",
	".wasm": "binary",
	".png": "dataurl",
	".jpg": "dataurl",
	".jpeg": "dataurl",
	".gif": "dataurl",
	".svg": "dataurl",
	".webp": "dataurl",
	".ico": "dataurl",
	".woff": "dataurl",
	".woff2": "dataurl",
	".ttf": "dataurl",
	".eot": "dataurl",
	".otf": "dataurl",
};

/** Loaders that operate on raw bytes rather than text */
const BINARY_LOADERS = new Set<esbuild.Loader>(["binary", "dataurl"]);

// ---------- Helpers ----------

/**
 * Get the esbuild loader for a file path based on its extension.
 */
export function getLoaderFromPath(path: string): esbuild.Loader {
	return LOADER_MAP[extname(path)] ?? "js";
}

// ---------- Resolution cache ----------

/**
 * Memoizes the resolver's filesystem probes so repeated imports don't re-issue
 * the same (async, and on the wasm path, boundary-crossing) `BundleFileSystem`
 * calls. The resolver asks the same questions over and over across hundreds of
 * imports: does `<dir>/node_modules/<pkg>` exist, what does this package.json
 * contain, is `<path>.ts` a file?
 *
 * Within a single build the answers cannot change, so caching them is always
 * correct. Across rebuilds in a persistent {@link BundleSession} the cache is
 * *retained* and invalidated surgically: the caller reports filesystem changes
 * via `markDirty`/`markFullReset` and the plugin applies them (`applyPending`)
 * at the start of the next build. We deliberately do NOT cache file *contents* —
 * `onLoad` re-reads every time, leaving content caching to the filesystem
 * backing.
 *
 * In the one-shot path a fresh cache is created per build, so nothing is ever
 * pending and the persistence machinery is inert.
 */
export interface ResolveCache {
	/** path → stat, or `null` when the path does not exist. */
	stat: Map<string, BundleFileStat | null>;
	/** package dir → parsed package.json, or `null` when absent/unparseable. */
	pkgJson: Map<string, Record<string, unknown> | null>;
	/** `${startDir}\0${specifier}` → bare-import resolution result. */
	bare: Map<string, esbuild.OnResolveResult>;
	/**
	 * Queue a single project-file path for invalidation. Only its `stat` entry is
	 * dropped; the next build re-probes that exact candidate and recomputes any
	 * relative resolution that depended on it.
	 */
	markDirty(path: string): void;
	/**
	 * Queue a full reset (clear all three maps). Used for `node_modules` /
	 * `package.json` changes, where bare-import decisions and parsed manifests may
	 * be affected, and for explicit `invalidate()`.
	 */
	markFullReset(): void;
	/** Apply queued invalidations. Called from the plugin's `onStart`. */
	applyPending(): void;
}

export function createResolveCache(): ResolveCache {
	const stat = new Map<string, BundleFileStat | null>();
	const pkgJson = new Map<string, Record<string, unknown> | null>();
	const bare = new Map<string, esbuild.OnResolveResult>();
	const dirtyPaths = new Set<string>();
	let fullReset = false;

	return {
		stat,
		pkgJson,
		bare,
		markDirty(path: string) {
			dirtyPaths.add(path);
		},
		markFullReset() {
			fullReset = true;
		},
		applyPending() {
			if (fullReset) {
				stat.clear();
				pkgJson.clear();
				bare.clear();
			} else {
				for (const path of dirtyPaths) {
					stat.delete(path);
				}
			}
			dirtyPaths.clear();
			fullReset = false;
		},
	};
}

/**
 * Stat a path through the cache. This collapses the resolver's old
 * `exists` + `stat` pair into a single (memoized) filesystem call, returning
 * `null` when the path does not exist.
 */
async function statCached(
	fs: BundleFileSystem,
	cache: ResolveCache,
	path: string,
): Promise<BundleFileStat | null> {
	const cached = cache.stat.get(path);
	if (cached !== undefined) return cached;

	let result: BundleFileStat | null;
	try {
		result = await fs.stat(path);
	} catch {
		result = null;
	}
	cache.stat.set(path, result);
	return result;
}

/**
 * Read and parse a package's package.json at most once per build.
 */
async function readPkgJsonCached(
	fs: BundleFileSystem,
	cache: ResolveCache,
	packageDir: string,
	virtualFiles?: VirtualFileMap,
): Promise<Record<string, unknown> | null> {
	const cached = cache.pkgJson.get(packageDir);
	if (cached !== undefined) return cached;

	const pkgJsonPath = join(packageDir, "package.json");
	let parsed: Record<string, unknown> | null = null;

	const virtual = virtualFiles?.[pkgJsonPath];
	try {
		if (virtual) {
			parsed = JSON.parse(
				typeof virtual.contents === "string"
					? virtual.contents
					: new TextDecoder().decode(virtual.contents),
			) as Record<string, unknown>;
		} else if ((await statCached(fs, cache, pkgJsonPath))?.isFile) {
			parsed = JSON.parse(await fs.readFile(pkgJsonPath)) as Record<
				string,
				unknown
			>;
		}
	} catch {
		parsed = null;
	}

	cache.pkgJson.set(packageDir, parsed);
	return parsed;
}

/**
 * Try to resolve `basePath` to an existing file on `fs`, first by appending
 * file extensions, then by looking for index files inside a directory.
 *
 * Returns the resolved path or `null` if nothing matched.
 */
async function resolveWithExtensions(
	fs: BundleFileSystem,
	cache: ResolveCache,
	basePath: string,
	virtualFiles?: VirtualFileMap,
): Promise<string | null> {
	// Try direct path + extensions
	for (const ext of RESOLVE_EXTENSIONS) {
		const fullPath = basePath + ext;
		if (virtualFiles?.[fullPath]) {
			return fullPath;
		}
		if ((await statCached(fs, cache, fullPath))?.isFile) {
			return fullPath;
		}
	}

	// Try index files inside the directory
	for (const ext of INDEX_EXTENSIONS) {
		const indexPath = join(basePath, `index${ext}`);
		if (virtualFiles?.[indexPath]) {
			return indexPath;
		}
		if ((await statCached(fs, cache, indexPath))?.isFile) {
			return indexPath;
		}
	}

	return null;
}

/**
 * Resolve a package.json `exports` condition map to a file path string.
 *
 * Handles:
 *   - `"./file.js"` (plain string)
 *   - `{ browser, import, default, require }` (condition object)
 *   - Nested conditions one level deep
 */
function resolveExportCondition(entry: unknown): string | null {
	if (typeof entry === "string") return entry;

	if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
		const obj = entry as Record<string, unknown>;
		let resolved = (obj.browser ?? obj.import ?? obj.default ?? obj.require) as
			| string
			| Record<string, unknown>
			| null
			| undefined;

		// Handle one level of nesting (e.g. { import: { default: "./file.js" } })
		if (resolved && typeof resolved === "object") {
			const nested = resolved as Record<string, unknown>;
			resolved = (nested.browser ?? nested.default ?? nested.import ?? null) as
				| string
				| null;
		}

		if (typeof resolved === "string") return resolved;
	}

	return null;
}

/**
 * Resolve a package's main entry point from its package.json fields.
 *
 * Checks (in order): exports["."], browser, module, main, then falls back
 * to "index.js".
 */
function resolvePackageEntry(pkgJson: Record<string, unknown>): string {
	// exports["."] or top-level exports (when exports itself is a condition map)
	const pkgExports = pkgJson.exports;
	if (
		pkgExports &&
		typeof pkgExports === "object" &&
		!Array.isArray(pkgExports)
	) {
		const exportsMap = pkgExports as Record<string, unknown>;
		const mainExport = exportsMap["."] ?? pkgExports;
		const resolved = resolveExportCondition(mainExport);
		if (resolved) return resolved;
	}

	// Top-level browser field (older convention)
	if (typeof pkgJson.browser === "string") return pkgJson.browser;

	// module / main
	if (typeof pkgJson.module === "string") return pkgJson.module;
	if (typeof pkgJson.main === "string") return pkgJson.main;

	return "index.js";
}

/**
 * Walk up the directory tree from `startDir` looking for
 * `node_modules/<packageName>`. Returns the package directory or `null`.
 */
async function findPackageDir(
	fs: BundleFileSystem,
	cache: ResolveCache,
	startDir: string,
	packageName: string,
	virtualFiles?: VirtualFileMap,
): Promise<string | null> {
	let dir = startDir;
	while (true) {
		const candidate = join(dir, "node_modules", packageName);
		if (
			virtualDirectoryExists(virtualFiles, candidate) ||
			(await statCached(fs, cache, candidate)) !== null
		) {
			return candidate;
		}

		const parent = dirname(dir);
		if (parent === dir) break; // reached root
		dir = parent;
	}
	return null;
}

function isAllowedExternal(
	specifier: string,
	policy: ResolvedResolutionPolicy,
): boolean {
	if (policy.allowedExternals.includes(specifier)) {
		return true;
	}

	try {
		const { name } = parsePackageSpecifier(specifier);
		return policy.allowedExternals.includes(name);
	} catch {
		return false;
	}
}

function virtualDirectoryExists(
	virtualFiles: VirtualFileMap | undefined,
	path: string,
): boolean {
	if (!virtualFiles) return false;
	const prefix = path === "/" ? "/" : `${path}/`;
	return Object.keys(virtualFiles).some((filePath) => filePath.startsWith(prefix));
}

function createPluginError(text: string): esbuild.OnResolveResult {
	return { errors: [{ text }] };
}

function formatUnresolvedImportError(
	specifier: string,
	importer: string,
	policy: ResolvedResolutionPolicy,
): string {
	return [
		`UNRESOLVED_IMPORT: Could not resolve package "${specifier}" imported from "${importer}".`,
		`Hint: install "${specifier}" or allow it as an external in the active resolution preset "${policy.preset}".`,
	].join("\n");
}

function formatUnsupportedBuiltinError(
	specifier: string,
	importer: string,
	policy: ResolvedResolutionPolicy,
): string {
	return [
		`UNSUPPORTED_BUILTIN_IMPORT: Node builtin "${specifier}" imported from "${importer}" is not available in the active resolution preset "${policy.preset}".`,
		`Hint: switch to the "executable-node" preset or configure "${specifier}" as an intentional external.`,
	].join("\n");
}

// ---------- Native import tracker ----------

/**
 * Tracks native Node.js module imports during bundling.
 */
export interface NativeImportTracker {
	/** Record an import of a native module */
	recordImport(module: string, importer: string): void;
	/** Get all recorded imports */
	getImports(): Map<string, Set<string>>;
	/** Clear recorded imports (called at the start of each rebuild). */
	reset(): void;
}

export function createNativeImportTracker(): NativeImportTracker {
	const imports = new Map<string, Set<string>>();

	return {
		recordImport(module: string, importer: string) {
			const normalized = normalizeBuiltinName(module);
			let importers = imports.get(normalized);
			if (!importers) {
				importers = new Set();
				imports.set(normalized, importers);
			}
			importers.add(importer);
		},
		getImports() {
			return imports;
		},
		reset() {
			imports.clear();
		},
	};
}

// ---------- esbuild plugin ----------

/**
 * Create an esbuild plugin that reads from a BundleFileSystem.
 *
 * @param fs - The filesystem to read source files from
 * @param options - Resolution directories for entry and package lookups
 * @param nativeTracker - Optional tracker for native module imports
 * @param cache - Optional resolution cache. Pass a persistent cache to retain
 *   resolutions across rebuilds (a {@link BundleSession}); omit it for the
 *   one-shot path, where a fresh per-build cache is created.
 */
export function createFileSystemPlugin(
	fs: BundleFileSystem,
	options: {
		entryResolveDir: string;
		packageResolveDir: string;
		resolution: ResolvedResolutionPolicy;
		virtualFiles?: VirtualFileMap;
	},
	nativeTracker?: NativeImportTracker,
	cache: ResolveCache = createResolveCache(),
): esbuild.Plugin {
	const { entryResolveDir, packageResolveDir, resolution, virtualFiles } =
		options;
	return {
		name: "filesystem",
		setup(build) {
			// ---- Per-rebuild reset ----
			// With a persistent BuildContext the plugin is set up once but the
			// filesystem may change between rebuilds. The native-import tracker is
			// rebuilt from scratch each time, while the resolution cache only drops
			// the entries the caller reported as changed (applyPending) — unchanged
			// resolutions survive across rebuilds. onStart is guaranteed to run
			// before any onResolve/onLoad in the same build.
			build.onStart(() => {
				nativeTracker?.reset();
				cache.applyPending();
			});

			// ---- Resolve ----
			build.onResolve({ filter: /.*/ }, async (args) => {
				// Node.js built-ins → external
				if (isNodeBuiltin(args.path)) {
					if (resolution.nodeBuiltins === "error") {
						return createPluginError(
							formatUnsupportedBuiltinError(
								args.path,
								args.importer || "entry",
								resolution,
							),
						);
					}

					nativeTracker?.recordImport(args.path, args.importer || "entry");
					return { path: args.path, external: true, sideEffects: false };
				}

				// Entry point
				if (args.kind === "entry-point") {
					return {
						path: isAbsolute(args.path)
							? args.path
							: join(entryResolveDir, args.path),
						namespace: "fs",
					};
				}

				// Path aliases (e.g. "@/" → project src directory)
				const aliases = build.initialOptions.alias ?? {};
				for (const [prefix, target] of Object.entries(aliases)) {
					if (args.path === prefix || args.path.startsWith(`${prefix}/`)) {
						const rest = args.path.slice(prefix.length);
						const aliasedPath = join(target, `.${rest}`);
						const resolved = await resolveWithExtensions(
							fs,
							cache,
							aliasedPath,
							virtualFiles,
						);
						return { path: resolved ?? aliasedPath, namespace: "fs" };
					}
				}

				// Relative imports
				if (args.path.startsWith(".")) {
					const importerDir =
						args.resolveDir || (args.importer ? dirname(args.importer) : entryResolveDir);
					const basePath = join(importerDir, args.path);
					const resolved = await resolveWithExtensions(
						fs,
						cache,
						basePath,
						virtualFiles,
					);
					return { path: resolved ?? basePath, namespace: "fs" };
				}

				// Bare imports (node_modules)
				if (!args.path.startsWith("/")) {
					if (isAllowedExternal(args.path, resolution)) {
						return { path: args.path, external: true, sideEffects: false };
					}

					const resolveFrom = args.importer
						? dirname(args.importer)
						: packageResolveDir;
					return await resolveBareImport(
						fs,
						cache,
						resolveFrom,
						args.path,
						args.importer || "entry",
						resolution,
						virtualFiles,
					);
				}

				// Absolute paths
				return { path: args.path, namespace: "fs" };
			});

			// ---- Load ----
			build.onLoad({ filter: /.*/, namespace: "fs" }, async (args) => {
				const virtualFile = virtualFiles?.[args.path];
				if (virtualFile) {
					return {
						contents: virtualFile.contents,
						loader: virtualFile.loader ?? getLoaderFromPath(args.path),
						resolveDir: virtualFile.resolveDir ?? dirname(args.path),
					};
				}

				// Read directly and treat a failure as "not found" — this avoids a
				// redundant `exists` probe before every load (one fewer FS call per
				// file, which matters most on the wasm boundary).
				const loader = getLoaderFromPath(args.path);
				try {
					const contents = BINARY_LOADERS.has(loader)
						? await fs.readFileBuffer(args.path)
						: await fs.readFile(args.path);

					return {
						contents,
						loader,
						resolveDir: dirname(args.path),
					};
				} catch {
					return { errors: [{ text: `File not found: ${args.path}` }] };
				}
			});
		},
	};
}

/**
 * Resolve a bare import specifier (e.g. "react", "@scope/pkg/sub") by walking up
 * node_modules directories.
 *
 * The result is memoized per `(startDir, specifier)` for the build: a package
 * like `lodash` imported from dozens of files resolves (and parses its
 * package.json) exactly once.
 */
async function resolveBareImport(
	fs: BundleFileSystem,
	cache: ResolveCache,
	startDir: string,
	specifier: string,
	importer: string,
	policy: ResolvedResolutionPolicy,
	virtualFiles?: VirtualFileMap,
): Promise<esbuild.OnResolveResult> {
	const memoKey = `${startDir}\0${specifier}`;
	const memoized = cache.bare.get(memoKey);
	if (memoized) return memoized;

	const result = await resolveBareImportUncached(
		fs,
		cache,
		startDir,
		specifier,
		importer,
		policy,
		virtualFiles,
	);
	cache.bare.set(memoKey, result);
	return result;
}

async function resolveBareImportUncached(
	fs: BundleFileSystem,
	cache: ResolveCache,
	startDir: string,
	specifier: string,
	importer: string,
	policy: ResolvedResolutionPolicy,
	virtualFiles?: VirtualFileMap,
): Promise<esbuild.OnResolveResult> {
	const { name: packageName, subpath: rawSubpath } =
		parsePackageSpecifier(specifier);
	// parsePackageSpecifier returns "." for root, "./sub" for subpaths — normalize to bare string
	const subpath = rawSubpath === "." ? "" : rawSubpath.slice(2); // strip "./"

	// Walk up looking for node_modules/<package>
	const packageDir = await findPackageDir(
		fs,
		cache,
		startDir,
		packageName,
		virtualFiles,
	);
	if (!packageDir) {
		if (policy.missingBareImports === "external") {
			return { path: specifier, external: true, sideEffects: false };
		}

		return createPluginError(
			formatUnresolvedImportError(specifier, importer, policy),
		);
	}

	const pkgJson = await readPkgJsonCached(fs, cache, packageDir, virtualFiles);

	// Subpath import (e.g. "lodash/get")
	if (subpath) {
		// Check exports map first
		if (pkgJson?.exports && typeof pkgJson.exports === "object") {
			const exportsMap = pkgJson.exports as Record<string, unknown>;
			const resolved = resolveExportCondition(exportsMap[`./${subpath}`]);
			if (resolved) {
				return { path: join(packageDir, resolved), namespace: "fs" };
			}
		}

		// Fall back to filesystem resolution
		const basePath = join(packageDir, subpath);
		const resolved = await resolveWithExtensions(
			fs,
			cache,
			basePath,
			virtualFiles,
		);
		return { path: resolved ?? basePath, namespace: "fs" };
	}

	// Main entry point
	if (pkgJson) {
		const entry = resolvePackageEntry(pkgJson);
		return { path: join(packageDir, entry), namespace: "fs" };
	}

	// No package.json — try index.js
	const indexPath = join(packageDir, "index.js");
	if (virtualFiles?.[indexPath] || (await statCached(fs, cache, indexPath))?.isFile) {
		return { path: indexPath, namespace: "fs" };
	}

	return createPluginError(
		formatUnresolvedImportError(specifier, importer, policy),
	);
}
