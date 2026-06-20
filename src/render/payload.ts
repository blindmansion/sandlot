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

/** Synthetic entry path for the React Fast Refresh runtime bundle. */
const REFRESH_ENTRY = "/__sandlot_refresh__.js";

/** Marker file we probe to decide whether React Fast Refresh is available. */
const REACT_REFRESH_MANIFEST = "/node_modules/react-refresh/package.json";

/**
 * Synthetic source for the Fast Refresh runtime blob. Bundled with
 * `platform: "browser"` so esbuild substitutes `process.env.NODE_ENV` →
 * `"development"`, selecting the real (non-stub) `react-refresh` runtime. It
 * injects into the global hook eagerly so React (loaded later, in the vendor
 * blob) registers its renderer through the refresh-aware hook, then exports the
 * runtime instance for the module registry to thread into factories.
 */
const REFRESH_ENTRY_SOURCE = `
const RefreshRuntime = require("react-refresh/runtime");
const __global = typeof window !== "undefined" ? window : globalThis;
RefreshRuntime.injectIntoGlobalHook(__global);
// Babel-style globals: harmless no-ops here since registration is done at
// runtime by scanning module exports (no source-level $RefreshReg$ calls).
__global.$RefreshReg$ = function () {};
__global.$RefreshSig$ = function () { return function (type) { return type; }; };
module.exports = RefreshRuntime;
`;

/** Extensions we compile into individual registry factories. */
const COMPILABLE = /\.(tsx?|jsx?|mjs|cjs|json)$/;

/** Files that are React component modules by extension (JSX-bearing). */
const JSX_MODULE = /\.(tsx|jsx)$/;

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
	/**
	 * Emit per-module source maps (inline `data:` URIs on {@link RenderModule.map})
	 * so the runtime can map evaluated code back to original `.ts`/`.tsx` source in
	 * DevTools and stack traces. Defaults to `true`; disable to shrink the payload
	 * for production-style mounts where debugging fidelity is not needed.
	 */
	sourcemap?: boolean;
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

/** UTF-8-safe base64, working in both Node and the browser (esbuild-wasm). */
function toBase64Utf8(input: string): string {
	if (typeof Buffer !== "undefined") {
		return Buffer.from(input, "utf-8").toString("base64");
	}
	const bytes = new TextEncoder().encode(input);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/**
 * Turn an esbuild `transform` source map into an inline `data:` URI for a
 * `//# sourceMappingURL=` comment. `lineOffset` shifts every mapping down by the
 * wrapper lines the runtime prepends when it `eval`s a module factory: one for
 * the `(function (…) {` header, plus one more for the async IIFE on async
 * modules. `eval` line numbering is deterministic and the header is always a
 * single line (params are comma-joined), so the offset is a build-time constant.
 */
function inlineSourceMap(mapJson: string, lineOffset: number): string {
	let json = mapJson;
	if (lineOffset > 0) {
		const map = JSON.parse(mapJson) as { mappings?: string };
		map.mappings = ";".repeat(lineOffset) + (map.mappings ?? "");
		json = JSON.stringify(map);
	}
	return `data:application/json;charset=utf-8;base64,${toBase64Utf8(json)}`;
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

/** Whether a project module pulls in React (directly, or via JSX automatic). */
function moduleUsesReact(path: string, graph: BundleGraph): boolean {
	if (JSX_MODULE.test(path)) return true;
	for (const edge of graph[path]?.imports ?? []) {
		const spec = edge.original;
		if (spec === "react" || spec?.startsWith("react/")) return true;
		if (edge.path.includes("/node_modules/react/")) return true;
	}
	return false;
}

/**
 * Decide whether React Fast Refresh should be wired in: the project must import
 * React *and* have `react-refresh` installed. When false the render path behaves
 * exactly as Phase 4 (no refresh blob, no per-module registration footers), so
 * non-React projects pay nothing.
 */
async function detectReactRefresh(
	fs: BundleFileSystem,
	graph: BundleGraph,
	projectPaths: Set<string>,
): Promise<boolean> {
	const usesReact = [...projectPaths].some((p) => moduleUsesReact(p, graph));
	if (!usesReact) return false;
	return fs.exists(REACT_REFRESH_MANIFEST);
}

/**
 * Footer appended to a compiled component module: register every export that
 * looks like a React component under a stable family id (`<path> <export>`), and
 * self-accept iff *all* exports are components (matching `react-refresh`'s own
 * boundary rule — a module that also exports non-components must propagate so its
 * importers re-run). Registration on the initial mount seeds the families; on a
 * patch the re-run registers the new types under the same ids and the accept
 * walk calls `performReactRefresh()` to swap them in place, preserving state.
 */
function reactRefreshFooter(moduleId: string): string {
	const id = JSON.stringify(moduleId);
	return `
;(function () {
	if (!__react_refresh) return;
	var __rr = __react_refresh, __all = true, __any = false;
	for (var __k in module.exports) {
		var __v;
		try { __v = module.exports[__k]; } catch (e) { __all = false; continue; }
		if (__rr.isLikelyComponentType(__v)) { __any = true; __rr.register(__v, ${id} + " " + __k); }
		else { __all = false; }
	}
	if (__any && __all && import_meta_hot) import_meta_hot.accept();
})();`;
}

/**
 * Bundle the `react-refresh/runtime` into a self-injecting blob (see
 * {@link REFRESH_ENTRY_SOURCE}). Uses the full bundler so the runtime's own
 * dependency interop and the `process.env.NODE_ENV` substitution match a normal
 * browser build.
 */
async function buildRefreshBlob(
	esbuild: EsbuildAPI,
	fs: BundleFileSystem,
	target: string,
	define: Record<string, string>,
): Promise<string> {
	const result = await bundleWithEsbuild(esbuild, {
		fs,
		entryPoint: REFRESH_ENTRY,
		entryResolveDir: "/",
		virtualFiles: {
			[REFRESH_ENTRY]: { contents: REFRESH_ENTRY_SOURCE, loader: "js" },
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
	footer?: string,
	sourcemap = true,
): Promise<{ code: string; async: boolean; map?: string }> {
	const loader = loaderForPath(path);
	const hotDefine = { ...define, ...HOT_DEFINE };
	// `sourcemap: true` returns the map separately (no inline comment in code);
	// `sourcefile` names the original source the map (and `//# sourceURL`) points at.
	const mapOpts = sourcemap
		? ({ sourcemap: true, sourcefile: path } as const)
		: {};
	if (asyncEntry) {
		const out = await esbuild.transform(source, {
			loader,
			format: "esm",
			target,
			jsx: "automatic",
			define: hotDefine,
			...mapOpts,
		});
		// Async modules add the IIFE line on top of the eval header → offset 2.
		return {
			code: stripExports(out.code),
			async: true,
			...(sourcemap && out.map ? { map: inlineSourceMap(out.map, 2) } : {}),
		};
	}
	const out = await esbuild.transform(source, {
		loader,
		format: "cjs",
		target,
		jsx: "automatic",
		define: hotDefine,
		...mapOpts,
	});
	// The footer (if any) is appended after the mapped body, so the offset is
	// just the single eval-header line.
	return {
		code: footer ? `${out.code}\n${footer}` : out.code,
		async: false,
		...(sourcemap && out.map ? { map: inlineSourceMap(out.map, 1) } : {}),
	};
}

/**
 * The Fast Refresh registration footer for a project module, or `undefined` when
 * it shouldn't get one (refresh disabled, the import-less async entry, or a
 * module that doesn't touch React). Shared by the initial payload and patches so
 * a hot-swapped module is instrumented identically to its mounted self.
 */
function footerFor(
	reactRefresh: boolean,
	asyncEntry: boolean,
	path: string,
	graph: BundleGraph,
): string | undefined {
	if (!reactRefresh || asyncEntry) return undefined;
	if (!moduleUsesReact(path, graph)) return undefined;
	return reactRefreshFooter(path);
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
		sourcemap = true,
	} = args;

	const entry = isAbsolute(args.entryPoint)
		? args.entryPoint
		: resolve(entryResolveDir, args.entryPoint);

	const projectPaths = new Set(
		Object.keys(bundle.graph).filter(isProjectModule),
	);

	const reactRefresh = await detectReactRefresh(
		fs,
		bundle.graph,
		projectPaths,
	);

	const modules: RenderModule[] = [];
	for (const path of projectPaths) {
		const source = await fs.readFile(path);
		const deps = projectDepsFor(path, bundle.graph, projectPaths);
		const asyncEntry = isAsyncEntry(path, entry, bundle.graph);
		const { code, async, map } = await compileModule(
			esbuild,
			source,
			path,
			asyncEntry,
			target,
			define,
			footerFor(reactRefresh, asyncEntry, path, bundle.graph),
			sourcemap,
		);
		modules.push({ path, code, deps, async, ...(map ? { map } : {}) });
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
		...(reactRefresh
			? { refresh: await buildRefreshBlob(esbuild, fs, target, define) }
			: {}),
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
	/**
	 * Emit per-module source maps (inline `data:` URIs on {@link RenderModule.map}).
	 * Defaults to `true`. Keep this aligned with the initial payload so a
	 * hot-swapped module debugs identically to its mounted self.
	 */
	sourcemap?: boolean;
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
		sourcemap = true,
	} = args;

	const entry = isAbsolute(args.entryPoint)
		? args.entryPoint
		: resolve(entryResolveDir, args.entryPoint);

	const projectPaths = new Set(
		Object.keys(bundle.graph).filter(isProjectModule),
	);

	const reactRefresh = await detectReactRefresh(
		fs,
		bundle.graph,
		projectPaths,
	);

	const modules: RenderModule[] = [];
	for (const path of args.changedPaths) {
		if (!projectPaths.has(path)) continue;
		const source = await fs.readFile(path);
		const deps = projectDepsFor(path, bundle.graph, projectPaths);
		const asyncEntry = isAsyncEntry(path, entry, bundle.graph);
		const { code, async, map } = await compileModule(
			esbuild,
			source,
			path,
			asyncEntry,
			target,
			define,
			footerFor(reactRefresh, asyncEntry, path, bundle.graph),
			sourcemap,
		);
		modules.push({ path, code, deps, async, ...(map ? { map } : {}) });
	}
	return modules;
}
