/**
 * Tests for the render payload builder (`buildRenderPayload`).
 *
 * These build a real payload with native esbuild, then execute it through a
 * reference implementation of the module-registry runtime (mirroring what the
 * iframe preamble emits). Running the payload in Node — no DOM needed for these
 * pure-logic modules — verifies the end-to-end contract: vendor blob + per-module
 * factories + `require` resolution + async-entry handling.
 */

import { expect, test } from "bun:test";
import { bundleWithEsbuild, resolveBundleOptions } from "../src/toolchain/bundle/core";
import { createNativeEsbuild } from "../src/toolchain/bundle/native";
import type { BundleFileSystem } from "../src/toolchain/bundle/fs";
import { buildRenderPatch, buildRenderPayload } from "../src/render/payload";
import type { RenderModule, RenderPayload } from "../src/render/types";
import { createWorkspace, loadFixture } from "./helpers";

const esbuild = createNativeEsbuild();

async function bundleAndBuildPayload(
	fs: BundleFileSystem,
	entryPoint: string,
): Promise<RenderPayload> {
	const bundle = await bundleWithEsbuild(esbuild, {
		fs,
		entryPoint,
		entryResolveDir: "/",
		options: resolveBundleOptions(undefined, {
			format: "esm",
			platform: "browser",
			target: "es2022",
		}),
	});
	return buildRenderPayload({ esbuild, fs, entryPoint, bundle, target: "es2022" });
}

// ---------------------------------------------------------------------------
// Reference registry runtime — the Node mirror of the iframe preamble runtime.
// ---------------------------------------------------------------------------

/** Mirror of the iframe `__applyPatch` result. */
interface PatchOutcome {
	mode: "boundary" | "rerun";
	boundaries: string[];
	/** The entry module's exports after the patch settled. */
	exports: Record<string, unknown>;
}

interface Runtime {
	start(): Promise<Record<string, unknown>>;
	/** Mirror of the iframe `__applyPatch` + accept-boundary walk. */
	applyPatch(modules: RenderModule[]): Promise<PatchOutcome>;
}

interface HotEntry {
	data: Record<string, unknown>;
	accepted: boolean;
	acceptCb: ((exports: unknown) => void) | null;
	onDispose: ((data: Record<string, unknown>) => void) | null;
}

/**
 * A faithful Node mirror of the iframe registry runtime, including the Phase 4
 * accept-boundary walk. Lets us exercise `import.meta.hot.accept()`/`dispose`,
 * sibling-state preservation, and the soft-rerun fallback without a DOM.
 */
function makeRuntime(
	payload: RenderPayload,
	globals: Record<string, unknown> = {},
): Runtime {
	const gNames = Object.keys(globals);
	const gVals = Object.values(globals);

	// Refresh blob (Phase 5) → the react-refresh runtime instance, evaluated
	// before the vendor blob (mirroring the iframe mount order). Only
	// performReactRefresh is invoked from the reference runtime (register /
	// isLikelyComponentType are called from inside module code).
	let refresh: { performReactRefresh(): void } | null = null;
	if (payload.refresh) {
		const refreshModule: { exports: Record<string, unknown> } = { exports: {} };
		new Function("module", "exports", payload.refresh)(
			refreshModule,
			refreshModule.exports,
		);
		refresh = refreshModule.exports as unknown as { performReactRefresh(): void };
	}

	// Vendor blob → { [specifier]: exports } map.
	const vendorModule: { exports: Record<string, unknown> } = { exports: {} };
	new Function("module", "exports", payload.vendor)(
		vendorModule,
		vendorModule.exports,
	);
	const vendor = vendorModule.exports;

	interface Record_ {
		factory: (...args: unknown[]) => unknown;
		deps: Record<string, string>;
		async: boolean;
		ret?: unknown;
	}
	const registry = new Map<string, Record_>();
	const cache = new Map<string, { exports: Record<string, unknown> }>();
	const hot = new Map<string, HotEntry>();

	function makeHot(key: string): unknown {
		let entry = hot.get(key);
		if (!entry) {
			entry = { data: {}, accepted: false, acceptCb: null, onDispose: null };
			hot.set(key, entry);
		}
		entry.accepted = false;
		entry.acceptCb = null;
		entry.onDispose = null;
		return {
			accept(cb?: (exports: unknown) => void) {
				(entry as HotEntry).accepted = true;
				(entry as HotEntry).acceptCb = typeof cb === "function" ? cb : null;
			},
			dispose(cb?: (data: Record<string, unknown>) => void) {
				(entry as HotEntry).onDispose = typeof cb === "function" ? cb : null;
			},
			get data() {
				return (entry as HotEntry).data;
			},
		};
	}

	function registerModule(m: RenderModule): void {
		// Async modules (import-less entry mount code) may use top-level await, so
		// their body runs inside an async IIFE whose promise the runtime awaits.
		const body = m.async ? `return (async () => {\n${m.code}\n})();` : m.code;
		const factory = new Function(
			"module",
			"exports",
			"require",
			"import_meta_hot",
			"__react_refresh",
			...gNames,
			body,
		) as Record_["factory"];
		registry.set(m.path, { factory, deps: m.deps, async: m.async });
	}

	for (const m of payload.modules) registerModule(m);

	function requireSync(fromPath: string | null, spec: string): unknown {
		const reg = fromPath != null ? registry.get(fromPath) : null;
		let key: string | null = null;
		if (reg && reg.deps[spec]) key = reg.deps[spec] as string;
		else if (registry.has(spec)) key = spec;

		if (key == null) {
			if (Object.prototype.hasOwnProperty.call(vendor, spec)) return vendor[spec];
			if (/\.css$/.test(spec)) return {};
			throw new Error(`Cannot find module '${spec}' from '${fromPath}'`);
		}
		return instantiate(key).exports;
	}

	function instantiate(key: string): { exports: Record<string, unknown> } {
		const cached = cache.get(key);
		if (cached) return cached;
		const rec = registry.get(key);
		if (!rec) throw new Error(`Not registered: ${key}`);
		const module = { exports: {} as Record<string, unknown> };
		cache.set(key, module);
		rec.ret = rec.factory(
			module,
			module.exports,
			(s: string) => requireSync(key, s),
			makeHot(key),
			refresh,
			...gVals,
		);
		return module;
	}

	function buildImporters(): Map<string, Set<string>> {
		const importers = new Map<string, Set<string>>();
		for (const [path, rec] of registry) {
			for (const spec in rec.deps) {
				const target = rec.deps[spec] as string;
				let set = importers.get(target);
				if (!set) {
					set = new Set();
					importers.set(target, set);
				}
				set.add(path);
			}
		}
		return importers;
	}

	async function runEntry(): Promise<Record<string, unknown>> {
		const module = instantiate(payload.entry);
		const rec = registry.get(payload.entry);
		if (rec?.ret && typeof (rec.ret as { then?: unknown }).then === "function") {
			rec.ret;
		}
		return module.exports;
	}

	async function softRerun(): Promise<Record<string, unknown>> {
		cache.clear();
		return runEntry();
	}

	async function acceptWalk(changedPaths: string[]): Promise<PatchOutcome> {
		const importers = buildImporters();
		const affected = new Set<string>();
		const boundaries: string[] = [];
		const queue = changedPaths.slice();
		const seen = new Set(changedPaths);
		let needsRerun = false;
		while (queue.length) {
			const path = queue.shift() as string;
			affected.add(path);
			const h = hot.get(path);
			if (h?.accepted) {
				boundaries.push(path);
				continue;
			}
			const imps = importers.get(path);
			if (!imps || imps.size === 0) {
				needsRerun = true;
				break;
			}
			for (const imp of imps)
				if (!seen.has(imp)) {
					seen.add(imp);
					queue.push(imp);
				}
		}
		if (needsRerun) {
			const exports = await softRerun();
			return { mode: "rerun", boundaries: [], exports };
		}
		for (const path of affected) {
			const h = hot.get(path);
			if (h?.onDispose) {
				try {
					h.onDispose(h.data);
				} catch {
					/* dispose errors don't abort the walk */
				}
			}
			cache.delete(path);
		}
		for (const path of boundaries) {
			const module = instantiate(path);
			const rec = registry.get(path);
			if (
				rec?.ret &&
				typeof (rec.ret as { then?: unknown }).then === "function"
			) {
				rec.ret;
			}
			const h = hot.get(path);
			if (h?.acceptCb) {
				try {
					h.acceptCb(module.exports);
				} catch {
					/* accept callback errors don't abort the walk */
				}
			}
		}
		if (refresh && boundaries.length) {
			try {
				refresh.performReactRefresh();
			} catch {
				/* refresh errors don't abort the walk */
			}
		}
		return {
			mode: "boundary",
			boundaries,
			exports: instantiate(payload.entry).exports,
		};
	}

	return {
		start: runEntry,
		async applyPatch(modules: RenderModule[]) {
			for (const m of modules) registerModule(m);
			return acceptWalk(modules.map((m) => m.path));
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("basic fixture: project modules registered, empty vendor, require resolves", async () => {
	const ws = await loadFixture("basic");
	try {
		const payload = await bundleAndBuildPayload(ws.fs, "/src/index.ts");

		expect(payload.entry).toBe("/src/index.ts");
		const paths = payload.modules.map((m) => m.path).sort();
		expect(paths).toEqual(["/src/greeting.ts", "/src/index.ts"]);
		// No dependencies → empty vendor map.
		expect(payload.vendor.replace(/\s/g, "")).toBe("module.exports={};");

		// greeting.ts is imported by others → must be CJS (exports preserved).
		const greeting = payload.modules.find((m) => m.path === "/src/greeting.ts");
		expect(greeting?.async).toBe(false);
		// index.ts has an import edge → CJS, with a project dep mapping.
		const index = payload.modules.find((m) => m.path === "/src/index.ts");
		expect(index?.async).toBe(false);
		expect(index?.deps).toEqual({ "./greeting": "/src/greeting.ts" });

		const exports = await makeRuntime(payload).start();
		expect(typeof exports.main).toBe("function");
		expect((exports.main as () => string)()).toBe("Hello, world!");
	} finally {
		await ws.cleanup();
	}
});

test("dependency import resolves through the vendor blob", async () => {
	const ws = await createWorkspace("payload-dep");
	try {
		await ws.fs.mkdir("/src", { recursive: true });
		await ws.fs.mkdir("/node_modules/leftpad", { recursive: true });
		await ws.fs.writeFile(
			"/node_modules/leftpad/package.json",
			JSON.stringify({ name: "leftpad", version: "1.0.0", main: "index.js" }),
		);
		await ws.fs.writeFile(
			"/node_modules/leftpad/index.js",
			"module.exports = function leftpad(s){ return ' ' + s; };",
		);
		await ws.fs.writeFile(
			"/package.json",
			JSON.stringify({ name: "demo", dependencies: { leftpad: "1.0.0" } }),
		);
		await ws.fs.writeFile("/src/util.ts", "export const two = 2;\n");
		await ws.fs.writeFile(
			"/src/index.ts",
			'import pad from "leftpad";\nimport { two } from "./util";\nexport const v = pad(String(two));\n',
		);

		const payload = await bundleAndBuildPayload(ws.fs, "/src/index.ts");

		// leftpad is a dependency → in the vendor blob, NOT a registered module.
		const modulePaths = payload.modules.map((m) => m.path).sort();
		expect(modulePaths).toEqual(["/src/index.ts", "/src/util.ts"]);
		expect(payload.vendor).toContain("leftpad");

		const exports = await makeRuntime(payload).start();
		expect(exports.v).toBe(" 2");
	} finally {
		await ws.cleanup();
	}
});

test("buildRenderPatch recompiles a changed leaf and the re-run reflects it", async () => {
	const ws = await loadFixture("basic");
	try {
		const payload = await bundleAndBuildPayload(ws.fs, "/src/index.ts");
		const runtime = makeRuntime(payload);

		// Initial mount reflects the original greeting.
		const before = await runtime.start();
		expect((before.main as () => string)()).toBe("Hello, world!");

		// Edit a leaf module, rebuild, and build a patch for just that file.
		await ws.fs.writeFile(
			"/src/greeting.ts",
			"export function greeting(name: string): string {\n\treturn `Hi, ${name}.`;\n}\n",
		);
		const bundle = await bundleWithEsbuild(esbuild, {
			fs: ws.fs,
			entryPoint: "/src/index.ts",
			entryResolveDir: "/",
			options: resolveBundleOptions(undefined, {
				format: "esm",
				platform: "browser",
				target: "es2022",
			}),
		});
		const patch = await buildRenderPatch({
			esbuild,
			fs: ws.fs,
			entryPoint: "/src/index.ts",
			bundle,
			changedPaths: ["/src/greeting.ts"],
			target: "es2022",
		});

		// Only the changed module is in the patch, with its deps preserved.
		expect(patch.map((m) => m.path)).toEqual(["/src/greeting.ts"]);
		expect(patch[0]?.async).toBe(false);

		// No module accepts, so the changed leaf propagates up to the entry root
		// and falls back to a soft re-run; the new source is reflected.
		const after = await runtime.applyPatch(patch);
		expect(after.mode).toBe("rerun");
		expect((after.exports.main as () => string)()).toBe("Hi, world.");
	} finally {
		await ws.cleanup();
	}
});

test("accept boundary re-runs only its subgraph and preserves sibling state", async () => {
	const ws = await createWorkspace("payload-accept");
	try {
		await ws.fs.mkdir("/src", { recursive: true });
		// A singleton store whose instance must survive a boundary patch.
		await ws.fs.writeFile(
			"/src/store.ts",
			"export const store = { value: 0 };\n",
		);
		// The entry self-accepts: each (re-)run bumps the shared store and stamps
		// a label, so we can tell a state-preserving boundary re-run (store keeps
		// accumulating) from a state-resetting soft re-run (store back to 0).
		await ws.fs.writeFile(
			"/src/index.ts",
			'import { store } from "./store";\n' +
			"store.value += 1;\n" +
			"import.meta.hot.accept();\n" +
			'export const label = "v1";\n' +
			"export const total = () => store.value;\n",
		);

		const payload = await bundleAndBuildPayload(ws.fs, "/src/index.ts");
		const index = payload.modules.find((m) => m.path === "/src/index.ts");
		// The accept call survived compilation as `import_meta_hot.accept()`.
		expect(index?.code).toContain("import_meta_hot.accept()");

		const runtime = makeRuntime(payload);
		const before = await runtime.start();
		expect((before.total as () => number)()).toBe(1);
		expect(before.label).toBe("v1");

		// Edit only the entry's label, rebuild, patch.
		await ws.fs.writeFile(
			"/src/index.ts",
			'import { store } from "./store";\n' +
			"store.value += 1;\n" +
			"import.meta.hot.accept();\n" +
			'export const label = "v2";\n' +
			"export const total = () => store.value;\n",
		);
		const bundle = await bundleWithEsbuild(esbuild, {
			fs: ws.fs,
			entryPoint: "/src/index.ts",
			entryResolveDir: "/",
			options: resolveBundleOptions(undefined, {
				format: "esm",
				platform: "browser",
				target: "es2022",
			}),
		});
		const patch = await buildRenderPatch({
			esbuild,
			fs: ws.fs,
			entryPoint: "/src/index.ts",
			bundle,
			changedPaths: ["/src/index.ts"],
			target: "es2022",
		});

		const after = await runtime.applyPatch(patch);
		// The entry self-accepted, so the walk re-ran only it as a boundary.
		expect(after.mode).toBe("boundary");
		expect(after.boundaries).toEqual(["/src/index.ts"]);
		expect(after.exports.label).toBe("v2");
		// store (a sibling, unchanged) kept its instance: value went 1 → 2, not
		// reset to 0 then back to 1 (which is what a soft re-run would produce).
		expect((after.exports.total as () => number)()).toBe(2);
	} finally {
		await ws.cleanup();
	}
});

test("import.meta.hot.dispose stashes state that the re-run reads back", async () => {
	const ws = await createWorkspace("payload-dispose");
	try {
		await ws.fs.mkdir("/src", { recursive: true });
		// A trivial dep so the entry compiles as CJS (exports preserved) rather
		// than the import-less async-ESM path (which strips exports).
		await ws.fs.writeFile("/src/tag.ts", "export const tag = 'demo';\n");
		// The module seeds its counter from hot.data (set by the previous
		// instance's dispose), so a boundary patch carries the value forward even
		// though the module itself holds the only copy of the state.
		const source = (label: string) =>
			'import { tag } from "./tag";\n' +
			"const start = import.meta.hot.data.count || 0;\n" +
			"let count = start + 1;\n" +
			"import.meta.hot.dispose((data) => { data.count = count; });\n" +
			"import.meta.hot.accept();\n" +
			`export const label = ${JSON.stringify(label)} + tag;\n` +
			"export const value = () => count;\n";
		await ws.fs.writeFile("/src/index.ts", source("v1"));

		const payload = await bundleAndBuildPayload(ws.fs, "/src/index.ts");
		const runtime = makeRuntime(payload);
		const before = await runtime.start();
		expect((before.value as () => number)()).toBe(1);

		await ws.fs.writeFile("/src/index.ts", source("v2"));
		const bundle = await bundleWithEsbuild(esbuild, {
			fs: ws.fs,
			entryPoint: "/src/index.ts",
			entryResolveDir: "/",
			options: resolveBundleOptions(undefined, {
				format: "esm",
				platform: "browser",
				target: "es2022",
			}),
		});
		const patch = await buildRenderPatch({
			esbuild,
			fs: ws.fs,
			entryPoint: "/src/index.ts",
			bundle,
			changedPaths: ["/src/index.ts"],
			target: "es2022",
		});

		const after = await runtime.applyPatch(patch);
		expect(after.mode).toBe("boundary");
		expect(after.exports.label).toBe("v2demo");
		// dispose stashed count=1; the new instance read it back and bumped to 2.
		expect((after.exports.value as () => number)()).toBe(2);
	} finally {
		await ws.cleanup();
	}
});

test("react fast refresh: component module registers + refreshes under a stable family id", async () => {
	const ws = await createWorkspace("payload-refresh");
	try {
		await ws.fs.mkdir("/src", { recursive: true });
		// Minimal `react` stub so a component module's `import { useState }`
		// resolves into the vendor blob (no real React needed for this wiring test).
		await ws.fs.mkdir("/node_modules/react", { recursive: true });
		await ws.fs.writeFile(
			"/node_modules/react/package.json",
			JSON.stringify({ name: "react", version: "18.0.0", main: "index.js" }),
		);
		await ws.fs.writeFile(
			"/node_modules/react/index.js",
			"exports.useState = function (init) { return [init, function () {}]; };\n",
		);
		// Minimal `react-refresh` stub. Its runtime records register/refresh/inject
		// calls onto a global sink so the test can assert the wiring fired. This is
		// the same surface (`injectIntoGlobalHook`, `register`,
		// `isLikelyComponentType`, `performReactRefresh`) the real runtime exposes.
		await ws.fs.mkdir("/node_modules/react-refresh", { recursive: true });
		await ws.fs.writeFile(
			"/node_modules/react-refresh/package.json",
			JSON.stringify({
				name: "react-refresh",
				version: "0.14.2",
				main: "runtime.js",
			}),
		);
		await ws.fs.writeFile(
			"/node_modules/react-refresh/runtime.js",
			[
				"var sink = globalThis;",
				"var log = sink.__SANDLOT_RR__;",
				"exports.injectIntoGlobalHook = function () { log.injected++; };",
				"exports.register = function (type, id) { log.registers.push(id); log.families[id] = type; };",
				'exports.isLikelyComponentType = function (v) { return typeof v === "function" && /^[A-Z]/.test(v.name || ""); };',
				"exports.performReactRefresh = function () { log.refreshes++; };",
				"exports.createSignatureFunctionForTransform = function () { return function (t) { return t; }; };",
				"",
			].join("\n"),
		);
		await ws.fs.writeFile(
			"/package.json",
			JSON.stringify({ name: "demo", dependencies: { react: "18.0.0" } }),
		);

		const widget = (label: string) =>
			'import { useState } from "react";\n' +
			"export function Widget() {\n" +
			"\tconst [n] = useState(0);\n" +
			`\treturn ${JSON.stringify(label)} + n;\n` +
			"}\n";
		await ws.fs.writeFile("/src/widget.ts", widget("widget:"));
		// Entry doesn't touch React → not a refresh boundary; it just renders the
		// component so the family is seeded on mount.
		await ws.fs.writeFile(
			"/src/index.ts",
			'import { Widget } from "./widget";\n' +
			"export const view = () => Widget();\n",
		);

		const payload = await bundleAndBuildPayload(ws.fs, "/src/index.ts");
		// A refresh blob is shipped, and the component module carries the footer.
		expect(typeof payload.refresh).toBe("string");
		expect(payload.refresh).toContain("injectIntoGlobalHook");
		const widgetMod = payload.modules.find((m) => m.path === "/src/widget.ts");
		expect(widgetMod?.code).toContain("isLikelyComponentType");
		expect(widgetMod?.code).toContain("import_meta_hot.accept()");
		// The entry has no React → no footer.
		const indexMod = payload.modules.find((m) => m.path === "/src/index.ts");
		expect(indexMod?.code).not.toContain("isLikelyComponentType");

		const sink = globalThis as unknown as {
			__SANDLOT_RR__: {
				injected: number;
				refreshes: number;
				registers: string[];
				families: Record<string, () => string>;
			};
		};
		sink.__SANDLOT_RR__ = {
			injected: 0,
			refreshes: 0,
			registers: [],
			families: {},
		};

		const runtime = makeRuntime(payload);
		const before = await runtime.start();
		// The refresh runtime injected before vendor, and the component registered
		// under its stable family id on the initial mount.
		expect(sink.__SANDLOT_RR__.injected).toBe(1);
		expect(sink.__SANDLOT_RR__.registers).toContain("/src/widget.ts Widget");
		expect(sink.__SANDLOT_RR__.refreshes).toBe(0);
		expect((before.view as () => string)()).toBe("widget:0");
		const firstType = sink.__SANDLOT_RR__.families["/src/widget.ts Widget"];

		// Edit the component body and patch it in.
		await ws.fs.writeFile("/src/widget.ts", widget("WIDGET:"));
		const bundle = await bundleWithEsbuild(esbuild, {
			fs: ws.fs,
			entryPoint: "/src/index.ts",
			entryResolveDir: "/",
			options: resolveBundleOptions(undefined, {
				format: "esm",
				platform: "browser",
				target: "es2022",
			}),
		});
		const patch = await buildRenderPatch({
			esbuild,
			fs: ws.fs,
			entryPoint: "/src/index.ts",
			bundle,
			changedPaths: ["/src/widget.ts"],
			target: "es2022",
		});

		const after = await runtime.applyPatch(patch);
		// widget self-accepted → it's the boundary; the refresh ran once.
		expect(after.mode).toBe("boundary");
		expect(after.boundaries).toEqual(["/src/widget.ts"]);
		expect(sink.__SANDLOT_RR__.refreshes).toBe(1);
		// The new component type was registered under the *same* family id — the
		// mechanism by which React swaps implementations while preserving state.
		const secondType = sink.__SANDLOT_RR__.families["/src/widget.ts Widget"];
		expect(secondType).not.toBe(firstType);
		expect(secondType?.()).toBe("WIDGET:0");
	} finally {
		await ws.cleanup();
	}
});

test("import-less entry compiles async and supports top-level await", async () => {
	const ws = await createWorkspace("payload-tla");
	try {
		await ws.fs.mkdir("/src", { recursive: true });
		await ws.fs.writeFile(
			"/src/main.ts",
			"const x = await Promise.resolve(42);\n" +
			"globalThis.__sandlot_tla__ = x;\n" +
			"export {};\n",
		);

		const payload = await bundleAndBuildPayload(ws.fs, "/src/main.ts");
		const entry = payload.modules.find((m) => m.path === "/src/main.ts");
		expect(entry?.async).toBe(true);

		(globalThis as Record<string, unknown>).__sandlot_tla__ = undefined;
		await makeRuntime(payload).start();
		expect((globalThis as Record<string, unknown>).__sandlot_tla__).toBe(42);
	} finally {
		await ws.cleanup();
	}
});
