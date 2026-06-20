/**
 * Render payload builder.
 *
 * Turns a project's bundle graph into a {@link RenderPayload} the iframe render
 * runtime can mount as a module registry: a single bundled **vendor blob** for
 * everything under `node_modules`, plus one **factory per project module** so
 * individual source files are addressable (and, later, hot-swappable).
 *
 * Why not just ship esbuild's bundled string? A `bundle: true` output dissolves
 * every module boundary into one closure, leaving nothing to address or swap.
 * To recover per-module granularity we compile each project module on its own
 * (`esbuild.transform`) and resolve its imports at runtime via a registry.
 *
 * Module compilation is a hybrid keyed off the import graph:
 *
 * - **Modules with imports** → `cjs`. Their `require(...)` calls are left intact
 *   and resolved by the runtime (project specifiers → registry, bare specifiers
 *   → vendor map). `cjs` cannot express top-level `await`, but a module that
 *   imports something is not import-less mount code, so this is fine.
 * - **Import-less modules** → `esm` with `export {...}` stripped, wrapped so the
 *   body can use top-level `await` (mount snippets rely on this). The graph
 *   having zero edges guarantees there is nothing to `require` *and* that no
 *   JSX runtime import was injected, so the stripped output is self-contained.
 */

import { bundleWithEsbuild, resolveBundleOptions } from "../toolchain/bundle/core";
import type { BundleFileSystem } from "../toolchain/bundle/fs";
import type { BundleGraph, BundleResult, EsbuildAPI } from "../toolchain/bundle/types";
import { isAbsolute, resolve } from "../toolchain/util";
import type { RenderModule, RenderPayload } from "./types";

const NODE_MODULES = "/node_modules/";

/** Synthetic entry path for the vendor (node_modules) bundle. */
const VENDOR_ENTRY = "/__sandlot_vendor__.js";

/** Extensions we compile into individual registry factories. */
const COMPILABLE = /\.(tsx?|jsx?|mjs|cjs|json)$/;

/**
 * The runtime injects a per-module hot context as the `import_meta_hot` factory
 * parameter. Mapping `import.meta.hot` to that identifier lets module source use
 * the familiar `import.meta.hot.accept()` / `.dispose()` / `.data` API while the
 * registry runtime owns the implementation (the accept-boundary walk, §9).
 */
const HOT_DEFINE: Record<string, string> = {
	"import.meta.hot": "import_meta_hot",
};

export interface BuildRenderPayloadArgs {
	/** esbuild API (native or wasm) — used for per-module transform + vendor bundle. */
	esbuild: EsbuildAPI;
	/** Filesystem the project lives in (project sources + installed node_modules). */
	fs: BundleFileSystem;
	/** Entry point (absolute, or relative to `entryResolveDir`). */
	entryPoint: string;
	/** Directory a relative `entryPoint` resolves against. Defaults to `/`. */
	entryResolveDir?: string;
	/**
	 * The project's bundle result, providing the import {@link BundleGraph} and
	 * extracted CSS. Typically the output of a {@link BundleSession.rebuild}.
	 */
	bundle: BundleResult;
	/** esbuild target for per-module transforms (e.g. `es2022` to lower decorators). */
	target?: string;
	/** esbuild `define` map applied to each per-module transform. */
	define?: Record<string, string>;
}

/** Pick the esbuild loader for a project module path. */
function loaderForPath(
	path: string,
): "ts" | "tsx" | "jsx" | "js" | "json" {
	if (path.endsWith(".ts")) return "ts";
	if (path.endsWith(".tsx")) return "tsx";
	if (path.endsWith(".jsx")) return "jsx";
	if (path.endsWith(".json")) return "json";
	return "js";
}

/** A path is a project module (not a dependency) and is compilable. */
function isProjectModule(path: string): boolean {
	return !path.includes(NODE_MODULES) && COMPILABLE.test(path);
}

/**
 * Strip esbuild's `export { ... }` footer so an ESM transform result can run as
 * a plain (async) function body. Mirrors the runtime's historical export strip.
 */
function stripExports(code: string): string {
	return code.replace(/\bexport\s*\{[^}]*\}\s*;?/g, "");
}

/** Collect the set of bare specifiers any project module imports from node_modules. */
function collectVendorSpecifiers(
	graph: BundleGraph,
	projectPaths: Set<string>,
): string[] {
	const specs = new Set<string>();
	for (const path of projectPaths) {
		for (const edge of graph[path]?.imports ?? []) {
			if (edge.original && edge.path.includes(NODE_MODULES)) {
				specs.add(edge.original);
			}
		}
	}
	return [...specs].sort();
}

/**
 * Map a project module's written specifiers to the absolute registry keys they
 * resolve to — but only for imports that resolve to *other project modules*.
 * Bare (vendor) imports are intentionally omitted; the runtime resolves those
 * against the vendor map by their original specifier.
 */
function projectDepsFor(
	path: string,
	graph: BundleGraph,
	projectPaths: Set<string>,
): Record<string, string> {
	const deps: Record<string, string> = {};
	for (const edge of graph[path]?.imports ?? []) {
		if (edge.original && projectPaths.has(edge.path)) {
			deps[edge.original] = edge.path;
		}
	}
	return deps;
}

/**
 * Bundle everything the project imports from node_modules into one CJS blob that
 * evaluates to a `{ [specifier]: moduleExports }` map. Reusing the full bundler
 * here (rather than transforming each dep file) keeps dependency interop,
 * decorator lowering, and `define` identical to a normal build.
 */
async function buildVendorBlob(
	esbuild: EsbuildAPI,
	fs: BundleFileSystem,
	specifiers: string[],
	target: string,
	define: Record<string, string>,
): Promise<string> {
	if (specifiers.length === 0) return "module.exports = {};";

	const entryContents = `module.exports = {\n${specifiers
		.map((s) => `  ${JSON.stringify(s)}: require(${JSON.stringify(s)})`)
		.join(",\n")}\n};\n`;

	const result = await bundleWithEsbuild(esbuild, {
		fs,
		entryPoint: VENDOR_ENTRY,
		entryResolveDir: "/",
		virtualFiles: {
			[VENDOR_ENTRY]: { contents: entryContents, loader: "js" },
		},
		options: resolveBundleOptions(undefined, {
			format: "cjs",
			platform: "browser",
			target,
			define,
		}),
	});
	return result.code;
}

/**
 * Whether a project module compiles as an async-ESM body rather than CJS.
 *
 * The async/ESM path strips exports, so it is only safe for the entry, whose
 * exports the runtime discards. A non-entry import-less module (e.g. a leaf that
 * only exports helpers) must stay CJS so its exports survive. "Import-less" (no
 * graph edges) also guarantees no JSX runtime import was injected, so the
 * stripped output is self-contained and may use top-level `await` (mount code
 * relies on this).
 */
function isAsyncEntry(
	path: string,
	entry: string,
	graph: BundleGraph,
): boolean {
	return path === entry && (graph[path]?.imports.length ?? 0) === 0;
}

/** Compile one project module to a registry factory body (CJS, or async-ESM). */
async function compileModule(
	esbuild: EsbuildAPI,
	source: string,
	path: string,
	asyncEntry: boolean,
	target: string,
	define: Record<string, string>,
): Promise<{ code: string; async: boolean }> {
	const loader = loaderForPath(path);
	const hotDefine = { ...define, ...HOT_DEFINE };
	if (asyncEntry) {
		const out = await esbuild.transform(source, {
			loader,
			format: "esm",
			target,
			jsx: "automatic",
			define: hotDefine,
		});
		return { code: stripExports(out.code), async: true };
	}
	const out = await esbuild.transform(source, {
		loader,
		format: "cjs",
		target,
		jsx: "automatic",
		define: hotDefine,
	});
	return { code: out.code, async: false };
}

/**
 * Build a {@link RenderPayload} from a project's bundle result: a vendor blob,
 * one factory per project module, and the absolute entry key.
 */
export async function buildRenderPayload(
	args: BuildRenderPayloadArgs,
): Promise<RenderPayload> {
	const {
		esbuild,
		fs,
		bundle,
		entryResolveDir = "/",
		target = "es2022",
		define = {},
	} = args;

	const entry = isAbsolute(args.entryPoint)
		? args.entryPoint
		: resolve(entryResolveDir, args.entryPoint);

	const projectPaths = new Set(
		Object.keys(bundle.graph).filter(isProjectModule),
	);

	const modules: RenderModule[] = [];
	for (const path of projectPaths) {
		const source = await fs.readFile(path);
		const deps = projectDepsFor(path, bundle.graph, projectPaths);
		const { code, async } = await compileModule(
			esbuild,
			source,
			path,
			isAsyncEntry(path, entry, bundle.graph),
			target,
			define,
		);
		modules.push({ path, code, deps, async });
	}

	const vendorSpecifiers = collectVendorSpecifiers(bundle.graph, projectPaths);
	const vendor = await buildVendorBlob(
		esbuild,
		fs,
		vendorSpecifiers,
		target,
		define,
	);

	return {
		entry,
		modules,
		vendor,
		...(bundle.css ? { css: bundle.css } : {}),
	};
}

export interface BuildRenderPatchArgs {
	/** esbuild API (native or wasm) — used for per-module transform. */
	esbuild: EsbuildAPI;
	/** Filesystem the project lives in. */
	fs: BundleFileSystem;
	/** Entry point (absolute, or relative to `entryResolveDir`). */
	entryPoint: string;
	/** Directory a relative `entryPoint` resolves against. Defaults to `/`. */
	entryResolveDir?: string;
	/**
	 * A *fresh* bundle result (rebuild after the edits) — its {@link BundleGraph}
	 * supplies the changed modules' current dependency edges and validates that
	 * the project still resolves.
	 */
	bundle: BundleResult;
	/** The set of changed VFS paths to compile into swap factories. */
	changedPaths: string[];
	/** esbuild target for per-module transforms. */
	target?: string;
	/** esbuild `define` map applied to each per-module transform. */
	define?: Record<string, string>;
}

/**
 * Compile a set of changed project modules into swappable registry factories
 * (the {@link RenderModule} shape the runtime re-registers on `hmr-patch`).
 *
 * Only changed paths that are project modules present in the fresh graph are
 * compiled; anything else (a dependency, a deleted/unreachable file, a non-source
 * asset) is skipped — the caller decides whether the resulting patch set is
 * applicable or whether to fall back to a full reload. Dependency edges come
 * from the fresh graph, so a module that added/removed a project import carries
 * the updated `deps` map.
 */
export async function buildRenderPatch(
	args: BuildRenderPatchArgs,
): Promise<RenderModule[]> {
	const {
		esbuild,
		fs,
		bundle,
		entryResolveDir = "/",
		target = "es2022",
		define = {},
	} = args;

	const entry = isAbsolute(args.entryPoint)
		? args.entryPoint
		: resolve(entryResolveDir, args.entryPoint);

	const projectPaths = new Set(
		Object.keys(bundle.graph).filter(isProjectModule),
	);

	const modules: RenderModule[] = [];
	for (const path of args.changedPaths) {
		if (!projectPaths.has(path)) continue;
		const source = await fs.readFile(path);
		const deps = projectDepsFor(path, bundle.graph, projectPaths);
		const { code, async } = await compileModule(
			esbuild,
			source,
			path,
			isAsyncEntry(path, entry, bundle.graph),
			target,
			define,
		);
		modules.push({ path, code, deps, async });
	}
	return modules;
}
