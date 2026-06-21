/// <reference lib="dom" />
/**
 * Sandbox core: the sandlot toolchain (filesystem, typecheck, bundle, install,
 * run, render) wired around a single in-memory {@link MemoryUnionFs} and a pair
 * of iframes (a hidden Worker host for `run`, a visible host for `render`).
 *
 * This is the headless engine the coding-agent demo drives. It is a trimmed,
 * self-contained sibling of `test/browser/sandbox.ts`: it keeps the same
 * incremental typecheck/bundle sessions and the same single write path (so
 * every mutation notifies the sessions and they never go stale), but drops the
 * CDP-facade plumbing (handles, HMR patches) the agent demo doesn't need.
 *
 * Everything here returns plain, JSON-safe data so it can be surfaced directly
 * in the agent's tool output / UI.
 */

import ts from "typescript";
import { createSandHostFunctions } from "../../../src/host-functions";
import { generateHostFunctionDts } from "../../../src/run/dts";
import {
	type BundleOptions,
	type BundleSession,
	createBundleSession,
	createWasmEsbuild,
} from "../../../src/toolchain/bundle";
import {
	getProjectRoot,
	install,
	readDepsFromPackageJson,
} from "../../../src/toolchain/install";
import {
	createTypecheckSession,
	summarizeDiagnostics,
} from "../../../src/toolchain/typecheck";
import type { Diagnostic } from "../../../src/toolchain/typecheck";
import {
	buildRenderPayload,
	createIframeRenderFn,
	type RenderHandle,
} from "../../../src/render";
import { createIframeWorkerRunFn } from "../../../src/runtimes/iframe-worker-run";
import { MemoryUnionFs } from "../../helpers/memory-fs";

// esbuild-wasm requires the .wasm binary to match the JS package version.
const ESBUILD_WASM_URL =
	"https://cdn.jsdelivr.net/npm/esbuild-wasm@0.28.1/esbuild.wasm";

const NODE_MODULES_PATH = "/node_modules";

const RENDER_BUNDLE_OPTIONS: BundleOptions = {
	format: "esm",
	platform: "browser",
	target: "es2022",
};

export interface TypecheckReport {
	errorCount: number;
	warningCount: number;
	diagnostics: Diagnostic[];
}

export interface BundleReport {
	code: string;
	css?: string;
	inputs: string[];
}

export interface InstallReport {
	name: string;
	version: string;
}

export interface LogLine {
	level: string;
	text: string;
}

export interface ExecReport {
	ok: boolean;
	log: LogLine[];
	error?: { message: string; name?: string; stack?: string };
}

/** The toolchain surface the agent's bash + env build on top of. */
export interface SandboxCore {
	readonly fs: MemoryUnionFs;
	/** Warm esbuild-wasm so the first build doesn't pay the init cost mid-action. */
	ready(): Promise<void>;
	/** Single write path: persist content and notify the typecheck/bundle sessions. */
	writeFile(path: string, content: string): Promise<void>;
	/** Remove a path and notify the sessions (escalates render to a fresh mount). */
	removePath(
		path: string,
		options?: { recursive?: boolean; force?: boolean },
	): Promise<void>;
	typecheck(): Promise<TypecheckReport>;
	bundle(entryPoint: string, options?: BundleOptions): Promise<BundleReport>;
	install(specs?: string[]): Promise<InstallReport[]>;
	run(entryPoint: string): Promise<ExecReport>;
	render(entryPoint: string, options?: { css?: string }): Promise<ExecReport>;
	reset(): Promise<{ removed: number }>;
}

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
 * Construct the toolchain around a visible render iframe. A hidden Worker-host
 * iframe is created for `run`. The returned {@link SandboxCore} owns one
 * incremental typecheck session and a cache of bundle sessions, all fed by the
 * single `writeFile`/`removePath` write path.
 */
export function createSandboxCore(renderFrameEl: HTMLIFrameElement): SandboxCore {
	const fs = new MemoryUnionFs();
	const esbuild = createWasmEsbuild({ wasmURL: ESBUILD_WASM_URL });

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
		for (const session of bundleSessions.values()) session[kind](path);
	}

	function invalidateBundleSessions(): void {
		for (const session of bundleSessions.values()) session.invalidate();
	}

	async function disposeBundleSessions(): Promise<void> {
		const sessions = [...bundleSessions.values()];
		bundleSessions.clear();
		await Promise.all(sessions.map((s) => s.dispose()));
	}

	// Sand.* host functions so guest code (run/render) can call Sand.fs.*.
	const sandHostFunctions = createSandHostFunctions({ fs });
	const sandGlobals = new Map<string, string>([
		[
			"/__sandlot_globals__.d.ts",
			generateHostFunctionDts(sandHostFunctions, { async: true }),
		],
	]);

	const typecheckSession = createTypecheckSession({
		fs,
		mode: "render",
		useProjectTsConfig: true,
		compilerOptions: {
			strict: true,
			jsx: ts.JsxEmit.ReactJSX,
			jsxImportSource: "react",
		},
		globalDeclarations: sandGlobals,
	});

	// Hidden iframe hosting the Worker-based runner.
	const runFrame = document.createElement("iframe");
	runFrame.style.display = "none";
	document.body.appendChild(runFrame);
	const runFn = createIframeWorkerRunFn(runFrame);

	const renderFn = createIframeRenderFn(renderFrameEl);
	let currentRenderHandle: RenderHandle | null = null;

	async function writeFile(path: string, content: string): Promise<void> {
		await fs.writeFile(path, content);
		await typecheckSession.changed(path);
		notifyBundleSessions("changed", path);
	}

	async function removePath(
		path: string,
		options?: { recursive?: boolean; force?: boolean },
	): Promise<void> {
		await fs.rm(path, options);
		await typecheckSession.deleted(path);
		notifyBundleSessions("deleted", path);
	}

	return {
		fs,

		async ready() {
			await esbuild.build({ stdin: { contents: "1;", loader: "js" }, write: false });
		},

		writeFile,
		removePath,

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
				...RENDER_BUNDLE_OPTIONS,
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
				projectName: root?.name ?? "sandlot-agent",
			});
			typecheckSession.invalidate();
			invalidateBundleSessions();
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
			if (options?.css !== undefined) payload.css = options.css;
			const handle = renderFn({ payload, hostFunctions: sandHostFunctions });
			currentRenderHandle = handle;
			const result = await handle.result;
			return toExecReport(result);
		},

		async reset() {
			const topLevel = await fs.readdir("/");
			for (const name of topLevel) {
				await fs.rm(`/${name}`, { recursive: true, force: true });
			}
			await disposeBundleSessions();
			typecheckSession.invalidate();
			if (currentRenderHandle) {
				currentRenderHandle.close();
				currentRenderHandle = null;
				renderFrameEl.srcdoc = "";
			}
			return { removed: topLevel.length };
		},
	};
}
