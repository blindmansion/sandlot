/// <reference lib="dom" />
/**
 * Browser-agent bridge: expose the sandlot toolchain as a serializable
 * `window.sandlot` facade so a host-side coding agent can drive the in-memory
 * sandbox entirely through `agent-browser eval`.
 *
 * This is the interactive counterpart of `app.ts` (which runs a fixed smoke
 * script). Instead of executing a hardcoded sequence, this page constructs the
 * toolchain once — typecheck, bundle, install, run, render, all backed by a
 * single {@link MemoryUnionFs} — and attaches a facade to `window`.
 *
 * Design rule: every facade method returns structured-clone/JSON-safe data
 * only (strings, numbers, arrays, plain objects). Nothing that can't cross the
 * CDP `Runtime.evaluate` boundary (no FS instances, class instances, or
 * functions) is ever returned.
 *
 * Drive it from the host:
 *
 * `eval` evaluates a single expression and auto-awaits a returned promise, so
 * pass a promise directly (top-level `await` throws a SyntaxError):
 *
 * ```bash
 * agent-browser open http://localhost:4321/sandbox.html
 * agent-browser eval "sandlot.ready()"
 * agent-browser eval "sandlot.fs.seed({'/src/index.ts':'export const x=1'})"
 * agent-browser eval "sandlot.typecheck().then(r => r.errorCount)"
 * agent-browser eval "sandlot.bundle('/src/index.ts').then(r => r.inputs)"
 * agent-browser eval "sandlot.render('/src/view.ts')"
 * ```
 */

import ts from "typescript";
import { createSandHostFunctions } from "../../src/host-functions";
import { generateHostFunctionDts } from "../../src/run/dts";
import {
	type BundleOptions,
	type BundleSession,
	createBundleSession,
	createWasmEsbuild,
} from "../../src/toolchain/bundle";
import {
	getProjectRoot,
	install,
	readDepsFromPackageJson,
} from "../../src/toolchain/install";
import {
	createTypecheckSession,
	summarizeDiagnostics,
} from "../../src/toolchain/typecheck";
import type { Diagnostic } from "../../src/toolchain/typecheck";
import {
	buildRenderPatch,
	buildRenderPayload,
	createIframeRenderFn,
} from "../../src/render";
import type { EvalHandleToken, RenderHandle } from "../../src/render";
import { createIframeWorkerRunFn } from "../../src/runtimes/iframe-worker-run";
import { MemoryUnionFs } from "../helpers/memory-fs";

// esbuild-wasm requires the .wasm binary to match the JS package version.
// Pinned to the version in package.json (esbuild-wasm@0.28.1).
const ESBUILD_WASM_URL =
	"https://cdn.jsdelivr.net/npm/esbuild-wasm@0.28.1/esbuild.wasm";

const NODE_MODULES_PATH = "/node_modules";

// Bundle options the render path uses. Shared between `render()` and the CSS
// hot-swap re-bundle in `updateCss()` so both reuse the same incremental
// session (keyed by entry point + options).
const RENDER_BUNDLE_OPTIONS: BundleOptions = {
	format: "esm",
	platform: "browser",
	target: "es2022",
};

// ---------------------------------------------------------------------------
// Serializable result shapes (what crosses the CDP boundary)
// ---------------------------------------------------------------------------

interface FsStat {
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

interface TypecheckReport {
	errorCount: number;
	warningCount: number;
	diagnostics: Diagnostic[];
}

interface BundleReport {
	code: string;
	css?: string;
	inputs: string[];
}

interface InstallReport {
	name: string;
	version: string;
}

interface LogLine {
	level: string;
	text: string;
}

interface ExecReport {
	ok: boolean;
	log: LogLine[];
	error?: { message: string; name?: string; stack?: string };
}

interface EvalReport {
	ok: boolean;
	/** The return value of the evaluated code (structured-clone-safe). */
	value?: unknown;
	/** Opaque token for a kept return value (present on a successful `evaluateHandle`). */
	handle?: EvalHandleToken;
	error?: { message: string; name?: string; stack?: string };
}

interface CssUpdateReport {
	ok: boolean;
	/** The CSS that was applied to the live render (present on success). */
	css?: string;
	error?: { message: string; name?: string };
}

interface HotUpdateReport {
	ok: boolean;
	/**
	 * - `patched`  — changed modules were hot-swapped into the live render.
	 * - `reloaded` — a structural change (or a failed patch) forced a fresh mount.
	 * - `noop`     — nothing dirty since the last render/update.
	 * - `error`    — the rebuild failed (e.g. a syntax error in an edited file).
	 */
	outcome: "patched" | "reloaded" | "noop" | "error";
	/** The module paths that were patched (present when `outcome` is `patched`). */
	modules?: string[];
	/**
	 * How the live patch applied (present when `outcome` is `patched`):
	 * - `boundary` — the accept-boundary walk re-ran only the modules that opted
	 *   in via `import.meta.hot.accept()`; sibling component state was preserved.
	 * - `rerun` — no module accepted the change, so the entry was re-run in place
	 *   (in-app JS state reset; the realm, `window`, and CSS survived).
	 */
	mode?: "boundary" | "rerun";
	/** The accept-boundary modules that re-ran (present when `mode` is `boundary`). */
	boundaries?: string[];
	error?: { message: string; name?: string };
}

interface SandlotFs {
	read(path: string): Promise<string>;
	write(path: string, content: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	readdir(path: string): Promise<string[]>;
	stat(path: string): Promise<FsStat>;
	mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
	rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
	seed(map: Record<string, string>): Promise<void>;
	list(): Promise<string[]>;
}

interface SeedFixtureResult {
	fixture: string;
	files: string[];
	installed?: InstallReport[];
}

interface SandlotApi {
	ready(): Promise<void>;
	fs: SandlotFs;
	typecheck(): Promise<TypecheckReport>;
	bundle(entryPoint: string, options?: BundleOptions): Promise<BundleReport>;
	install(specs?: string[]): Promise<InstallReport[]>;
	run(entryPoint: string): Promise<ExecReport>;
	render(entryPoint: string, options?: { css?: string }): Promise<ExecReport>;
	/**
	 * Hot-swap the CSS of the active render in place — no document reload, no JS
	 * re-execution, zero DOM/state loss. Requires a prior `render(...)`.
	 *
	 * With no argument, re-bundles the active entry and swaps in the freshly
	 * extracted CSS (the natural flow after editing an imported `.css` file). An
	 * explicit `css` string overrides the bundle output and becomes the new
	 * override for subsequent calls. Returns `{ ok, css? }`.
	 */
	updateCss(css?: string): Promise<CssUpdateReport>;
	/**
	 * Apply source edits made since the last render/update to the live render
	 * without a full document reload, preserving the iframe realm, `window`, and
	 * CSS. Changed project modules are re-compiled and hot-swapped into the
	 * runtime, which runs the accept-boundary walk: a module that opted in via
	 * `import.meta.hot.accept()` re-runs only its own subgraph (`mode:
	 * "boundary"`), preserving sibling component state; otherwise the entry is
	 * re-run in place (`mode: "rerun"`, in-app state resets). Structural changes
	 * (installs, manifest edits, deletions) and unresolvable patches fall back to
	 * a fresh mount. Requires a prior `render(...)`. Returns
	 * `{ ok, outcome, modules?, mode?, boundaries? }`.
	 */
	hotUpdate(): Promise<HotUpdateReport>;
	/**
	 * Run JavaScript inside the currently-rendered iframe and return its value.
	 *
	 * This is the bridge into the sandboxed render iframe (which has no
	 * `allow-same-origin`, so the parent page can't read its DOM directly).
	 * The code is an async function body that may `return` a value and
	 * reference `__args`; it runs with the same `Sand.*` host functions and
	 * shares the rendered view's live DOM/`window`. Requires a prior
	 * `render(...)` call. Returns `{ ok, value?, error? }`.
	 *
	 * `args` may include handle tokens from a prior `evaluateHandle(...)`; each
	 * is re-hydrated into its live object inside the iframe before the code runs.
	 */
	evaluate(code: string, ...args: unknown[]): Promise<EvalReport>;
	/**
	 * Like `evaluate`, but keeps the top-level return value inside the iframe
	 * and returns an opaque `handle` token instead of structured-cloning it.
	 * Use this for non-serializable values (DOM nodes, class instances): hold
	 * the token and pass it back into later `evaluate`/`evaluateHandle` `...args`
	 * to operate on the live object. Release it with `releaseHandle(token)`.
	 * Returns `{ ok, handle?, error? }`. Requires a prior `render(...)`.
	 */
	evaluateHandle(code: string, ...args: unknown[]): Promise<EvalReport>;
	/** Release a handle previously returned by `evaluateHandle`. No-op if there is no active render. */
	releaseHandle(token: EvalHandleToken): Promise<void>;
	/** List committed fixtures available on the dev server (e.g. `lit-app`). */
	fixtures(): Promise<string[]>;
	/**
	 * Seed a committed fixture from `test/fixtures/<name>` into the in-memory
	 * filesystem. Pass `{ install: true }` to also install its declared deps.
	 */
	seedFixture(
		name: string,
		options?: { install?: boolean },
	): Promise<SeedFixtureResult>;
	/**
	 * Clear the in-memory filesystem (including installed `node_modules`/store)
	 * and reset the typecheck session, for switching tasks without reloading
	 * the page. Returns the number of top-level entries removed.
	 */
	reset(): Promise<{ removed: number }>;
}

declare global {
	interface Window {
		sandlot: SandlotApi;
		__SANDLOT_READY__: boolean;
	}
}

// ---------------------------------------------------------------------------
// Toolchain wiring (constructed once, shared across every eval call)
// ---------------------------------------------------------------------------

const fs = new MemoryUnionFs();
const esbuild = createWasmEsbuild({ wasmURL: ESBUILD_WASM_URL });

// Persistent, incremental bundle sessions keyed by entry point + options, so
// repeated bundle/run/render calls reuse esbuild's parsed graph and cached
// module resolution instead of rebuilding cold each time. Like the typecheck
// session, every fs mutation flows through the `fs` facade and notifies these
// sessions (changed/deleted) and `install()` invalidates them, so cached
// resolution can never go stale. `reset()` disposes them all.
const bundleSessions = new Map<string, BundleSession>();

async function getBundleSession(
	entryPoint: string,
	options: BundleOptions,
): Promise<BundleSession> {
	const key = JSON.stringify({ entryPoint, options });
	let session = bundleSessions.get(key);
	if (!session) {
		session = await createBundleSession(esbuild, {
			fs,
			entryPoint,
			entryResolveDir: "/",
			options,
		});
		bundleSessions.set(key, session);
	}
	return session;
}

function notifyBundleSessions(kind: "changed" | "deleted", path: string): void {
	for (const session of bundleSessions.values()) {
		session[kind](path);
	}
}

function invalidateBundleSessions(): void {
	for (const session of bundleSessions.values()) {
		session.invalidate();
	}
}

async function disposeBundleSessions(): Promise<void> {
	const sessions = [...bundleSessions.values()];
	bundleSessions.clear();
	await Promise.all(sessions.map((session) => session.dispose()));
}

// Sand.* host functions, shared by run/render so guest code can call Sand.fs.*.
const sandHostFunctions = createSandHostFunctions({ fs });

// Ambient declarations for the Sand.* globals, surfaced to the typechecker so
// guest code that uses `Sand.fs.readFile(...)` typechecks cleanly.
const sandGlobals = new Map<string, string>([
	[
		"/__sandlot_globals__.d.ts",
		generateHostFunctionDts(sandHostFunctions, { async: true }),
	],
]);

// One persistent, incremental typecheck session in `render` mode (ES + DOM
// libs). The fs facade is the single write path, so every mutation notifies
// the session; `install` invalidates it (node_modules changed).
const typecheckSession = createTypecheckSession({
	fs,
	mode: "render",
	// Load the seeded project's tsconfig.json (lazily, at first check) so its
	// `jsx`, `moduleResolution`, etc. apply; our options layer on top as
	// embedder-enforced fallbacks (e.g. JSX defaults for tsconfig-less projects).
	useProjectTsConfig: true,
	compilerOptions: {
		strict: true,
		jsx: ts.JsxEmit.ReactJSX,
		jsxImportSource: "react",
	},
	globalDeclarations: sandGlobals,
});

// Hidden iframe that hosts the Worker-based runner.
const runFrame = document.createElement("iframe");
runFrame.style.display = "none";
document.body.appendChild(runFrame);
const runFn = createIframeWorkerRunFn(runFrame);

// Visible iframe that hosts rendered views (declared in sandbox.html).
const renderFrameEl = document.getElementById("render-frame");
if (!(renderFrameEl instanceof HTMLIFrameElement)) {
	throw new Error("#render-frame iframe not found in sandbox.html");
}
const renderFn = createIframeRenderFn(renderFrameEl);

// The most recent render handle, kept so `evaluate` can run code inside the
// live rendered iframe. `createIframeRenderFn` tears down the previous render
// on each new call, so this always points at the currently-visible view.
let currentRenderHandle: RenderHandle | null = null;
// The entry point and explicit CSS override of the active render, so a CSS
// hot-swap (`updateCss`) can re-bundle the right project and honor an override.
let currentRenderEntry: string | null = null;
let currentRenderCssOverride: string | undefined;

// HMR change tracking. `fs.write` diffs content against the last-seen hash so a
// no-op rewrite doesn't mark a module dirty (the bundle session re-reads every
// file each rebuild, so we can't derive "what changed" from esbuild — §7 of the
// HMR plan). Structural changes (node_modules, manifests, deletions) can shift
// resolution/the graph, so they escalate to a full reload instead of a patch.
const moduleHashes = new Map<string, string>();
const dirtyModules = new Set<string>();
let pendingStructuralReload = false;

// Project source files we compile into swappable registry factories.
const PROJECT_SOURCE = /\.(tsx?|jsx?|mjs|cjs|json)$/;

/** A change that can shift bare-import resolution or the module graph. */
function isStructuralPath(path: string): boolean {
	return path.includes("/node_modules/") || /(^|\/)package\.json$/.test(path);
}

/** Tiny non-cryptographic content hash (djb2) for cheap change detection. */
function hashContent(content: string): string {
	let h = 5381;
	for (let i = 0; i < content.length; i++) {
		h = (h * 33) ^ content.charCodeAt(i);
	}
	return (h >>> 0).toString(36);
}

/** Record a write for the next `hotUpdate()`: dirty a source module or escalate. */
function trackWrite(path: string, content: string): void {
	if (isStructuralPath(path)) {
		pendingStructuralReload = true;
		return;
	}
	if (!PROJECT_SOURCE.test(path)) return;
	const next = hashContent(content);
	if (moduleHashes.get(path) !== next) {
		moduleHashes.set(path, next);
		dirtyModules.add(path);
	}
}

/** Clear pending change state — called after a (re)mount captures the latest. */
function clearDirtyState(): void {
	dirtyModules.clear();
	pendingStructuralReload = false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toExecReport(result: {
	ok: boolean;
	log: Array<{ level: string; text: string }>;
	error?: { message: string; name?: string; stack?: string };
}): ExecReport {
	return {
		ok: result.ok,
		log: result.log.map((l) => ({ level: l.level, text: l.text })),
		...(result.error
			? {
					error: {
						message: result.error.message,
						name: result.error.name,
						...(result.error.stack ? { stack: result.error.stack } : {}),
					},
				}
			: {}),
	};
}

/**
 * Drive `evaluate`/`evaluateHandle` on the active render and project the result
 * into a serializable {@link EvalReport}. `evaluate` surfaces a by-value `value`;
 * `evaluateHandle` surfaces an opaque `handle` token instead.
 */
async function runEvaluate(
	mode: "evaluate" | "evaluateHandle",
	code: string,
	args: unknown[],
): Promise<EvalReport> {
	if (!currentRenderHandle) {
		return {
			ok: false,
			error: { message: "No active render. Call render(...) first." },
		};
	}
	const result =
		mode === "evaluateHandle"
			? await currentRenderHandle.evaluateHandle(code, ...args)
			: await currentRenderHandle.evaluate(code, ...args);
	return {
		ok: result.ok,
		...(result.ok && mode === "evaluate" ? { value: result.value } : {}),
		...(result.ok && result.handle ? { handle: result.handle } : {}),
		...(result.error
			? {
					error: {
						message: result.error.message,
						name: result.error.name,
						...(result.error.stack ? { stack: result.error.stack } : {}),
					},
				}
			: {}),
	};
}

/**
 * Bundle the entry, build the registry payload, and mount it into the visible
 * iframe — the single mount path shared by `render()` and the `hotUpdate()`
 * full-reload fallback. Records the active render's entry + CSS override and
 * clears pending dirty state (the fresh mount reflects the latest sources).
 */
async function mountActiveRender(
	entryPoint: string,
	cssOverride: string | undefined,
): Promise<RenderHandle> {
	const session = await getBundleSession(entryPoint, RENDER_BUNDLE_OPTIONS);
	const bundle = await session.rebuild();
	const payload = await buildRenderPayload({
		esbuild,
		fs,
		entryPoint,
		entryResolveDir: "/",
		bundle,
		target: "es2022",
	});
	if (cssOverride !== undefined) payload.css = cssOverride;
	const handle = renderFn({ payload, hostFunctions: sandHostFunctions });
	currentRenderHandle = handle;
	currentRenderEntry = entryPoint;
	currentRenderCssOverride = cssOverride;
	clearDirtyState();
	return handle;
}

/** Re-mount the active render from scratch (the full-reload HMR fallback). */
async function remountActiveRender(): Promise<void> {
	if (!currentRenderEntry) return;
	const handle = await mountActiveRender(
		currentRenderEntry,
		currentRenderCssOverride,
	);
	await handle.result;
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

const sandlotFs: SandlotFs = {
	async read(path) {
		return fs.readFile(path);
	},
	async write(path, content) {
		await fs.writeFile(path, content);
		await typecheckSession.changed(path);
		notifyBundleSessions("changed", path);
		trackWrite(path, content);
	},
	async exists(path) {
		return fs.exists(path);
	},
	async readdir(path) {
		return fs.readdir(path);
	},
	async stat(path) {
		const s = await fs.stat(path);
		return {
			isFile: s.isFile,
			isDirectory: s.isDirectory,
			isSymbolicLink: s.isSymbolicLink,
		};
	},
	async mkdir(path, opts) {
		await fs.mkdir(path, opts);
	},
	async rm(path, opts) {
		await fs.rm(path, opts);
		await typecheckSession.deleted(path);
		notifyBundleSessions("deleted", path);
		// A deletion changes the module graph; escalate to a full reload.
		moduleHashes.delete(path);
		dirtyModules.delete(path);
		pendingStructuralReload = true;
	},
	async seed(map) {
		for (const [path, content] of Object.entries(map)) {
			await fs.writeFile(path, content);
			await typecheckSession.changed(path);
			notifyBundleSessions("changed", path);
			trackWrite(path, content);
		}
	},
	async list() {
		return fs.getAllPaths();
	},
};

const sandlot: SandlotApi = {
	async ready() {
		// Force esbuild-wasm initialization (lazy on first build) so subsequent
		// bundle/run/render calls don't pay the init cost mid-action.
		await esbuild.build({
			stdin: { contents: "1;", loader: "js" },
			write: false,
		});
	},

	fs: sandlotFs,

	async typecheck() {
		const { diagnostics } = await typecheckSession.check();
		const summary = summarizeDiagnostics(diagnostics);
		return {
			errorCount: summary.errorCount,
			warningCount: summary.warningCount,
			diagnostics: summary.all,
		};
	},

	async bundle(entryPoint, options) {
		const session = await getBundleSession(entryPoint, {
			format: "esm",
			platform: "browser",
			target: "es2022",
			...options,
		});
		const result = await session.rebuild();
		return { code: result.code, css: result.css, inputs: result.inputs };
	},

	async install(specs) {
		const root = await getProjectRoot({ cwd: "/", fs });
		const resolvedSpecs =
			specs ?? (root ? readDepsFromPackageJson(root.packageJson) : []);
		const installed = await install(fs, resolvedSpecs, {
			nodeModulesPath: NODE_MODULES_PATH,
			projectName: root?.name ?? "sandlot-sandbox",
		});
		// node_modules changed out from under the typecheck + bundle sessions.
		typecheckSession.invalidate();
		invalidateBundleSessions();
		// Dependencies changed → the vendor blob is stale; force a full reload.
		pendingStructuralReload = true;
		return installed.map((r) => ({ name: r.name, version: r.version }));
	},

	async run(entryPoint) {
		const session = await getBundleSession(entryPoint, {
			format: "esm",
			platform: "neutral",
			target: "es2022",
		});
		const { code } = await session.rebuild();
		const result = await runFn({ code, hostFunctions: sandHostFunctions });
		return toExecReport(result);
	},

	async render(entryPoint, options) {
		const handle = await mountActiveRender(entryPoint, options?.css);
		// Intentionally leave the handle open so the rendered view stays visible
		// in the iframe for screenshots and so `evaluate`/`hotUpdate` can run
		// against it. `createIframeRenderFn` tears down the previous render
		// automatically on the next mount.
		const result = await handle.result;
		return toExecReport(result);
	},

	async hotUpdate() {
		if (!currentRenderHandle || !currentRenderEntry) {
			return {
				ok: false,
				outcome: "noop",
				error: { message: "No active render. Call render(...) first." },
			};
		}
		const entry = currentRenderEntry;
		// Structural change (deps/manifest/deletion) → graph/resolution may have
		// shifted; a fresh mount is the safe move.
		if (pendingStructuralReload) {
			await remountActiveRender();
			return { ok: true, outcome: "reloaded" };
		}
		if (dirtyModules.size === 0) return { ok: true, outcome: "noop" };

		const changed = [...dirtyModules];
		dirtyModules.clear();
		try {
			const session = await getBundleSession(entry, RENDER_BUNDLE_OPTIONS);
			// Rebuild validates the edits and gives the fresh dependency graph.
			const bundle = await session.rebuild();
			const modules = await buildRenderPatch({
				esbuild,
				fs,
				entryPoint: entry,
				entryResolveDir: "/",
				bundle,
				changedPaths: changed,
				target: "es2022",
			});
			// Nothing compilable changed in the live graph (e.g. only an unreachable
			// file) — fall back to a fresh mount to stay correct.
			if (modules.length === 0) {
				await remountActiveRender();
				return { ok: true, outcome: "reloaded" };
			}
			const res = await currentRenderHandle.applyPatch(modules);
			if (res.outcome === "full-reload") {
				await remountActiveRender();
				return {
					ok: true,
					outcome: "reloaded",
					...(res.error
						? { error: { message: res.error.message, name: res.error.name } }
						: {}),
				};
			}
			return {
				ok: true,
				outcome: "patched",
				modules: modules.map((m) => m.path),
				...(res.mode ? { mode: res.mode } : {}),
				...(res.boundaries ? { boundaries: res.boundaries } : {}),
			};
		} catch (err) {
			// Re-dirty so a later retry (after fixing the error) still patches.
			for (const path of changed) dirtyModules.add(path);
			return {
				ok: false,
				outcome: "error",
				error: {
					message: err instanceof Error ? err.message : String(err),
					name: err instanceof Error ? err.name : "Error",
				},
			};
		}
	},

	async updateCss(css) {
		if (!currentRenderHandle || !currentRenderEntry) {
			return {
				ok: false,
				error: { message: "No active render. Call render(...) first." },
			};
		}
		let next = css;
		if (next === undefined) {
			// Re-derive CSS from a rebuild of the active entry (incremental — the
			// session is shared with render()). An explicit override from the
			// original render() still wins, mirroring the mount-time precedence.
			const session = await getBundleSession(
				currentRenderEntry,
				RENDER_BUNDLE_OPTIONS,
			);
			const bundle = await session.rebuild();
			next = currentRenderCssOverride ?? bundle.css ?? "";
		} else {
			// An explicit css argument becomes the new override so later
			// re-derivations keep honoring it.
			currentRenderCssOverride = css;
		}
		currentRenderHandle.applyCss(next);
		return { ok: true, css: next };
	},

	async evaluate(code, ...args) {
		return runEvaluate("evaluate", code, args);
	},

	async evaluateHandle(code, ...args) {
		return runEvaluate("evaluateHandle", code, args);
	},

	async releaseHandle(token) {
		currentRenderHandle?.releaseHandle(token);
	},

	async fixtures() {
		const res = await fetch("/fixtures");
		if (!res.ok) throw new Error(`failed to list fixtures (${res.status})`);
		return (await res.json()) as string[];
	},

	async seedFixture(name, options) {
		const res = await fetch(`/fixtures/${encodeURIComponent(name)}.json`);
		if (!res.ok) {
			throw new Error(`failed to load fixture "${name}" (${res.status})`);
		}
		const map = (await res.json()) as Record<string, string>;
		await sandlotFs.seed(map);
		const result: SeedFixtureResult = {
			fixture: name,
			files: Object.keys(map).sort(),
		};
		if (options?.install) {
			result.installed = await sandlot.install();
		}
		return result;
	},

	async reset() {
		const topLevel = await fs.readdir("/");
		for (const name of topLevel) {
			await fs.rm(`/${name}`, { recursive: true, force: true });
		}
		// The whole filesystem changed out from under the typecheck + bundle
		// sessions; drop the bundle sessions entirely (their build contexts are
		// bound to now-deleted entry points) and reset the typecheck session.
		await disposeBundleSessions();
		typecheckSession.invalidate();
		// Drop all HMR change tracking — the filesystem is gone.
		moduleHashes.clear();
		clearDirtyState();
		// Tear down the current render for a true clean slate: close the handle
		// (kills the transport and invalidates any outstanding evaluate handles)
		// and blank the visible iframe so the old view doesn't linger.
		if (currentRenderHandle) {
			currentRenderHandle.close();
			currentRenderHandle = null;
			currentRenderEntry = null;
			currentRenderCssOverride = undefined;
			renderFrameEl.srcdoc = "";
		}
		return { removed: topLevel.length };
	},
};

window.sandlot = sandlot;
window.__SANDLOT_READY__ = true;

const status = document.getElementById("status");
function setStatus(text: string): void {
	if (status) status.textContent = text;
}

// Optionally auto-seed a fixture so a session starts pre-loaded rather than
// from scratch: open `/sandbox.html?fixture=lit-app` (add `&install=1` to also
// install its declared dependencies).
const params = new URLSearchParams(location.search);
const autoFixture = params.get("fixture");

if (!autoFixture) {
	setStatus(
		"window.sandlot ready. Call `sandlot.ready()` to warm esbuild, then drive the toolchain. Tip: open ?fixture=<name> to auto-seed a fixture.",
	);
} else {
	const autoInstall = params.get("install") === "1";
	setStatus(`Seeding fixture "${autoFixture}"…`);
	void sandlot
		.seedFixture(autoFixture, { install: autoInstall })
		.then((result) => {
			const installedNote = result.installed
				? `, installed ${result.installed.length} package(s)`
				: "";
			setStatus(
				`Seeded fixture "${result.fixture}" (${result.files.length} files${installedNote}). window.sandlot ready.`,
			);
		})
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			setStatus(`Failed to seed fixture "${autoFixture}": ${message}`);
		});
}
