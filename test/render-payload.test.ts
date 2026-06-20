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
import { buildRenderPayload } from "../src/render/payload";
import type { RenderPayload } from "../src/render/types";
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

interface Runtime {
	start(): Promise<Record<string, unknown>>;
}

function makeRuntime(
	payload: RenderPayload,
	globals: Record<string, unknown> = {},
): Runtime {
	const gNames = Object.keys(globals);
	const gVals = Object.values(globals);

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

	for (const m of payload.modules) {
		// Async modules (import-less entry mount code) may use top-level await, so
		// their body runs inside an async IIFE whose promise the runtime awaits.
		const body = m.async ? `return (async () => {\n${m.code}\n})();` : m.code;
		const factory = new Function(
			"module",
			"exports",
			"require",
			...gNames,
			body,
		) as Record_["factory"];
		registry.set(m.path, { factory, deps: m.deps, async: m.async });
	}

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
			...gVals,
		);
		return module;
	}

	return {
		async start() {
			const module = instantiate(payload.entry);
			const rec = registry.get(payload.entry);
			if (
				rec?.ret &&
				typeof (rec.ret as { then?: unknown }).then === "function"
			) {
				await rec.ret;
			}
			return module.exports;
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
