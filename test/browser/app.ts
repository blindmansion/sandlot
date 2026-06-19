/// <reference lib="dom" />
/**
 * Browser smoke test for the library modules — typecheck, bundle, run, render,
 * and install — all running against an in-memory {@link MemoryUnionFs} inside a
 * Bun-bundled page.
 *
 * This is the browser analog of `test/smoke.ts`: it seeds a tiny project into
 * the in-memory filesystem, then drives each module end to end and renders a
 * pass/fail/skip checklist into the DOM. Sections that reach the network (the
 * TypeScript lib CDN, the esbuild-wasm binary, and the npm registry) degrade
 * gracefully to "skip" when offline, so the page still tells a useful story.
 */

import { createBundleFn, createWasmEsbuild } from "../../src/toolchain/bundle";
import { createSandHostFunctions } from "../../src/host-functions";
import {
	getProjectRoot,
	install,
	readDepsFromPackageJson,
} from "../../src/toolchain/install";
import { MemoryUnionFs } from "../helpers/memory-fs";
import { createIframeRenderFn } from "../../src/render";
import { createIframeWorkerRunFn } from "../../src/runtimes/iframe-worker-run";
import {
	createTypecheckSession,
	summarizeDiagnostics,
} from "../../src/toolchain/typecheck";

// esbuild-wasm requires the .wasm binary to match the JS package version.
// Pinned to the version in package.json (esbuild-wasm@0.28.1).
const ESBUILD_WASM_URL =
	"https://cdn.jsdelivr.net/npm/esbuild-wasm@0.28.1/esbuild.wasm";

/** A tiny project seeded into the in-memory filesystem. */
const PROJECT: Record<string, string> = {
	"/package.json": `${JSON.stringify(
		{
			name: "browser-demo",
			version: "1.0.0",
			dependencies: { "is-number": "^7.0.0" },
		},
		null,
		2,
	)}\n`,
	"/src/math.ts": "export function double(n: number): number {\n\treturn n * 2;\n}\n",
	"/src/index.ts":
		'import { double } from "./math";\n\n' +
		"export function main(): string {\n" +
		"\treturn `double(21) = ${double(21)}`;\n" +
		"}\n",
};

type Status = "pass" | "fail" | "skip";

interface Check {
	section: string;
	label: string;
	status: Status;
	detail: string;
}

/** Distinguish "the network was unavailable" from "the module misbehaved". */
function classifyError(error: unknown): { status: Status; detail: string } {
	const message = error instanceof Error ? error.message : String(error);
	const networky =
		/fetch|network|failed to (fetch|download|load)|load failed|registry|tarball|wasm|cdn|err_/i;
	return { status: networky.test(message) ? "skip" : "fail", detail: message };
}

/** Run a CommonJS bundle in the browser and return its exports. */
function runCjs<T>(code: string): T {
	const module: { exports: T } = { exports: {} as T };
	const fn = new Function(
		"module",
		"exports",
		`"use strict";\n${code}\n;return module.exports;`,
	) as (m: typeof module, e: T) => T;
	return (fn(module, module.exports) ?? module.exports) as T;
}

// ---------------------------------------------------------------------------
// Section 1 — Typecheck (network: TypeScript lib CDN)
// ---------------------------------------------------------------------------

async function typecheckSection(fs: MemoryUnionFs): Promise<Check[]> {
	const section = "typecheck";
	const checks: Check[] = [];
	const session = createTypecheckSession({
		fs,
		mode: "run",
		compilerOptions: { strict: true },
	});

	try {
		const clean = summarizeDiagnostics((await session.check()).diagnostics);
		checks.push({
			section,
			label: "clean project reports no errors",
			status: clean.errorCount === 0 ? "pass" : "fail",
			detail: `${clean.errorCount} errors`,
		});

		await fs.writeFile("/src/bad.ts", 'export const answer: number = "nope";\n');
		await session.created("/src/bad.ts");
		const dirty = summarizeDiagnostics((await session.check()).diagnostics);
		checks.push({
			section,
			label: "catches an introduced type error",
			status: dirty.errorCount > 0 ? "pass" : "fail",
			detail: `${dirty.errorCount} errors`,
		});

		await fs.rm("/src/bad.ts");
		await session.deleted("/src/bad.ts");
		const reclean = summarizeDiagnostics((await session.check()).diagnostics);
		checks.push({
			section,
			label: "error clears after the file is removed",
			status: reclean.errorCount === 0 ? "pass" : "fail",
			detail: `${reclean.errorCount} errors`,
		});
	} catch (error) {
		const { status, detail } = classifyError(error);
		checks.push({ section, label: "typecheck session", status, detail });
	} finally {
		session.dispose();
	}

	return checks;
}

// ---------------------------------------------------------------------------
// Section 2 — Bundle + run (network: esbuild-wasm binary)
// ---------------------------------------------------------------------------

async function bundleSection(
	fs: MemoryUnionFs,
	bundle: ReturnType<typeof createBundleFn>,
): Promise<Check[]> {
	const section = "bundle";
	const checks: Check[] = [];

	try {
		const result = await bundle({
			fs,
			entryPoint: "/src/index.ts",
			entryResolveDir: "/",
			options: { format: "cjs", platform: "neutral" },
		});

		checks.push({
			section,
			label: "produced JavaScript output",
			status: result.code.length > 0 ? "pass" : "fail",
			detail: `${result.code.length} bytes`,
		});

		const bundledBoth =
			result.inputs.some((i) => i.includes("index.ts")) &&
			result.inputs.some((i) => i.includes("math.ts"));
		checks.push({
			section,
			label: "followed the local import graph",
			status: bundledBoth ? "pass" : "fail",
			detail: result.inputs.join(", "),
		});

		const ran = runCjs<{ main(): string }>(result.code);
		const output = ran.main();
		checks.push({
			section,
			label: "executed output yields the right value",
			status: output.includes("42") ? "pass" : "fail",
			detail: output,
		});
	} catch (error) {
		const { status, detail } = classifyError(error);
		checks.push({ section, label: "esbuild-wasm bundle", status, detail });
	}

	return checks;
}

// ---------------------------------------------------------------------------
// Section 3 — Run (sandboxed iframe + Worker, network: esbuild-wasm binary)
// ---------------------------------------------------------------------------

/**
 * Bundle a snippet and execute it through the iframe worker runner.
 *
 * ESM format is used so the snippet can rely on top-level `await` (needed for
 * host-function round-trips); the guest preamble runs it inside an async IIFE.
 */
async function bundleAndRun(
	fs: MemoryUnionFs,
	bundle: ReturnType<typeof createBundleFn>,
	run: ReturnType<typeof createIframeWorkerRunFn>,
	path: string,
	source: string,
	hostFunctions?: ReturnType<typeof createSandHostFunctions>,
) {
	await fs.writeFile(path, source);
	const { code } = await bundle({
		fs,
		entryPoint: path,
		entryResolveDir: "/",
		options: { format: "esm", platform: "neutral" },
	});
	return run({ code, hostFunctions });
}

async function runnerSection(
	fs: MemoryUnionFs,
	bundle: ReturnType<typeof createBundleFn>,
): Promise<Check[]> {
	const section = "run";
	const checks: Check[] = [];

	const iframe = document.createElement("iframe");
	iframe.style.display = "none";
	document.body.appendChild(iframe);
	const run = createIframeWorkerRunFn(iframe);

	try {
		// 1. Execute bundled code in the worker and capture console output.
		const ran = await bundleAndRun(
			fs,
			bundle,
			run,
			"/src/task.ts",
			'console.log("hello from the worker");\n' +
			"console.log(`sum = ${19 + 23}`);\n" +
			"export {};\n",
		);
		const lines = ran.log.map((l) => l.text);
		const captured =
			ran.ok &&
			lines.some((t) => t.includes("hello from the worker")) &&
			lines.some((t) => t.includes("sum = 42"));
		checks.push({
			section,
			label: "ran bundled code in a sandboxed iframe worker",
			status: captured ? "pass" : "fail",
			detail: lines.join(" | ") || ran.error?.message || "(no output)",
		});

		// 2. Bridge a Sand.fs host call from the guest back to the host.
		const expectedLen = (await fs.readFile("/src/math.ts")).length;
		const hostRan = await bundleAndRun(
			fs,
			bundle,
			run,
			"/src/host-task.ts",
			'const text = await Sand.fs.readFile("/src/math.ts");\n' +
			'console.log(`math.ts length ${text.length}`);\n' +
			"export {};\n",
			createSandHostFunctions({ fs }),
		);
		const bridged =
			hostRan.ok &&
			hostRan.log.some((l) => l.text.includes(`math.ts length ${expectedLen}`));
		checks.push({
			section,
			label: "bridged a Sand.fs host call across the iframe boundary",
			status: bridged ? "pass" : "fail",
			detail:
				hostRan.log.map((l) => l.text).join(" | ") ||
				hostRan.error?.message ||
				"(no output)",
		});

		// 3. A thrown error surfaces as a failed run, not a crash.
		const threw = await bundleAndRun(
			fs,
			bundle,
			run,
			"/src/throws.ts",
			'throw new Error("boom from worker");\nexport {};\n',
		);
		const reported =
			!threw.ok && (threw.error?.message.includes("boom from worker") ?? false);
		checks.push({
			section,
			label: "reports a thrown error as a failed run",
			status: reported ? "pass" : "fail",
			detail: threw.error
				? `${threw.error.name ?? "Error"}: ${threw.error.message}`
				: `ok=${threw.ok}, no error captured`,
		});
	} catch (error) {
		const { status, detail } = classifyError(error);
		checks.push({ section, label: "iframe worker runner", status, detail });
	} finally {
		iframe.remove();
	}

	return checks;
}

// ---------------------------------------------------------------------------
// Section 4 — Render (sandboxed iframe + DOM, network: esbuild-wasm binary)
// ---------------------------------------------------------------------------

/**
 * Bundle a frontend snippet and mount it through the iframe render fn.
 *
 * Mirrors {@link bundleAndRun}, but uses the render module: the bundled code
 * runs inside the iframe document (with a `#root` element and an optional
 * `<style>` block) rather than in a headless Worker. The render iframe is
 * sandboxed without `allow-same-origin`, so the parent page can't read its
 * DOM — the snippet inspects its own DOM and reports back via the bridged
 * `console`, which is what we assert on.
 */
async function bundleAndRender(
	fs: MemoryUnionFs,
	bundle: ReturnType<typeof createBundleFn>,
	render: ReturnType<typeof createIframeRenderFn>,
	path: string,
	source: string,
	options?: {
		css?: string;
		hostFunctions?: ReturnType<typeof createSandHostFunctions>;
	},
) {
	await fs.writeFile(path, source);
	const { code } = await bundle({
		fs,
		entryPoint: path,
		entryResolveDir: "/",
		options: { format: "esm", platform: "neutral" },
	});
	const handle = render({
		code,
		css: options?.css,
		hostFunctions: options?.hostFunctions,
	});
	try {
		return await handle.result;
	} finally {
		handle.close();
	}
}

async function renderSection(
	fs: MemoryUnionFs,
	bundle: ReturnType<typeof createBundleFn>,
): Promise<Check[]> {
	const section = "render";
	const checks: Check[] = [];

	const iframe = document.createElement("iframe");
	iframe.style.display = "none";
	document.body.appendChild(iframe);
	const render = createIframeRenderFn(iframe);

	try {
		// 1 + 2. Mount bundled frontend code into the iframe DOM and apply the
		// injected CSS. The snippet inspects its own DOM and reports back.
		const mounted = await bundleAndRender(
			fs,
			bundle,
			render,
			"/src/view.ts",
			'const root = document.getElementById("root");\n' +
			'root.innerHTML = `<h1 class="greeting">Hello, ${21 + 21}</h1>`;\n' +
			'const h1 = root.querySelector("h1");\n' +
			"console.log(`mounted: ${h1.textContent}`);\n" +
			"console.log(`color: ${getComputedStyle(h1).color}`);\n" +
			"export {};\n",
			{ css: ".greeting { color: rgb(0, 128, 0); }" },
		);
		const mountedLines = mounted.log.map((l) => l.text);
		checks.push({
			section,
			label: "mounted bundled frontend code into the iframe DOM",
			status:
				mounted.ok && mountedLines.some((t) => t.includes("mounted: Hello, 42"))
					? "pass"
					: "fail",
			detail: mountedLines.join(" | ") || mounted.error?.message || "(no output)",
		});
		checks.push({
			section,
			label: "applied the injected CSS to the mounted DOM",
			status:
				mounted.ok && mountedLines.some((t) => t.includes("color: rgb(0, 128, 0)"))
					? "pass"
					: "fail",
			detail:
				mountedLines.find((t) => t.startsWith("color:")) ??
				mounted.error?.message ??
				"(no color reported)",
		});

		// 3. Bridge a Sand.fs host call from the rendered view back to the host.
		const expectedLen = (await fs.readFile("/src/math.ts")).length;
		const hostRendered = await bundleAndRender(
			fs,
			bundle,
			render,
			"/src/host-view.ts",
			'const text = await Sand.fs.readFile("/src/math.ts");\n' +
			'const root = document.getElementById("root");\n' +
			"root.textContent = `math.ts has ${text.length} chars`;\n" +
			"console.log(`rendered: ${root.textContent}`);\n" +
			"export {};\n",
			{ hostFunctions: createSandHostFunctions({ fs }) },
		);
		const bridged =
			hostRendered.ok &&
			hostRendered.log.some((l) =>
				l.text.includes(`math.ts has ${expectedLen} chars`),
			);
		checks.push({
			section,
			label: "bridged a Sand.fs host call from a rendered view",
			status: bridged ? "pass" : "fail",
			detail:
				hostRendered.log.map((l) => l.text).join(" | ") ||
				hostRendered.error?.message ||
				"(no output)",
		});

		// 4. A thrown error during render surfaces as a failed render.
		const threw = await bundleAndRender(
			fs,
			bundle,
			render,
			"/src/bad-view.ts",
			'throw new Error("boom from render");\nexport {};\n',
		);
		const reported =
			!threw.ok && (threw.error?.message.includes("boom from render") ?? false);
		checks.push({
			section,
			label: "reports a thrown error as a failed render",
			status: reported ? "pass" : "fail",
			detail: threw.error
				? `${threw.error.name ?? "Error"}: ${threw.error.message}`
				: `ok=${threw.ok}, no error captured`,
		});
	} catch (error) {
		const { status, detail } = classifyError(error);
		checks.push({ section, label: "iframe render", status, detail });
	} finally {
		iframe.remove();
	}

	return checks;
}

// ---------------------------------------------------------------------------
// Section 5 — Install + integration (network: npm registry)
// ---------------------------------------------------------------------------

async function installSection(
	fs: MemoryUnionFs,
	bundle: ReturnType<typeof createBundleFn>,
): Promise<Check[]> {
	const section = "install";
	const checks: Check[] = [];

	try {
		const root = await getProjectRoot({ cwd: "/", fs });
		const specs = root ? readDepsFromPackageJson(root.packageJson) : [];
		checks.push({
			section,
			label: "read declared deps from package.json",
			status: specs.includes("is-number@^7.0.0") ? "pass" : "fail",
			detail: specs.join(", ") || "(none)",
		});

		const installed = await install(fs, specs, {
			nodeModulesPath: "/node_modules",
			projectName: root?.name ?? "browser-demo",
		});
		checks.push({
			section,
			label: "downloaded the package into the store",
			status: installed.some((r) => r.name === "is-number") ? "pass" : "fail",
			detail: installed.map((r) => `${r.name}@${r.version}`).join(", "),
		});

		const link = "/node_modules/is-number";
		const isLink = (await fs.lstat(link)).isSymbolicLink;
		checks.push({
			section,
			label: "created a pnpm-style symlink into the store",
			status: isLink ? "pass" : "fail",
			detail: isLink ? await fs.readlink(link) : "not a symlink",
		});

		// Integration: bundle a module that imports the freshly installed dep.
		await fs.writeFile(
			"/src/with-dep.ts",
			'import isNumber from "is-number";\n' +
			'import { double } from "./math";\n\n' +
			"export function check(value: unknown): string {\n" +
			"\treturn isNumber(value) ? `number:${double(Number(value))}` : 'not a number';\n" +
			"}\n",
		);
		const result = await bundle({
			fs,
			entryPoint: "/src/with-dep.ts",
			entryResolveDir: "/",
			options: { format: "cjs", platform: "neutral" },
		});
		const pulledDep = result.inputs.some((i) => i.includes("is-number"));
		checks.push({
			section,
			label: "bundle resolves the installed dependency",
			status: pulledDep ? "pass" : "fail",
			detail: result.inputs.filter((i) => i.includes("node_modules")).join(", "),
		});

		const ran = runCjs<{ check(v: unknown): string }>(result.code);
		const ok = ran.check(21) === "number:42" && ran.check("x") === "not a number";
		checks.push({
			section,
			label: "executed output uses the dependency",
			status: ok ? "pass" : "fail",
			detail: `check(21)=${ran.check(21)}, check("x")=${ran.check("x")}`,
		});
	} catch (error) {
		const { status, detail } = classifyError(error);
		checks.push({ section, label: "install + integration", status, detail });
	}

	return checks;
}

// ---------------------------------------------------------------------------
// Section 6 — Live demo (install + bundle + render a real Lit app, visibly)
// ---------------------------------------------------------------------------

/**
 * End-to-end showcase: pull the committed `lit-app` fixture into an in-memory
 * filesystem, install `lit` (and its deps) from npm, bundle it, then mount the
 * result into a *visible, persistent* iframe so you can actually interact with
 * the rendered widget.
 *
 * Unlike {@link renderSection} (which renders into a hidden, torn-down iframe
 * and verifies via the console bridge), this leaves the render alive: the
 * handle is never closed and the iframe is never removed.
 */
async function liveDemoSection(
	bundle: ReturnType<typeof createBundleFn>,
): Promise<Check[]> {
	const section = "demo";
	const checks: Check[] = [];

	const frame = document.getElementById("demo-frame");
	const statusEl = document.getElementById("demo-status");
	const setStatus = (text: string) => {
		if (statusEl) statusEl.textContent = text;
	};

	if (!(frame instanceof HTMLIFrameElement)) {
		checks.push({
			section,
			label: "live demo iframe is present",
			status: "fail",
			detail: "#demo-frame not found",
		});
		return checks;
	}

	try {
		setStatus("Loading the lit-app fixture…");
		const res = await fetch("./lit-fixture.json");
		if (!res.ok) {
			throw new Error(`failed to load lit fixture (${res.status})`);
		}
		const litFiles = (await res.json()) as Record<string, string>;
		const fs = new MemoryUnionFs(litFiles);
		checks.push({
			section,
			label: "loaded the lit-app fixture into memory",
			status: Object.keys(litFiles).length > 0 ? "pass" : "fail",
			detail: `${Object.keys(litFiles).length} files`,
		});

		setStatus("Installing lit from npm…");
		const root = await getProjectRoot({ cwd: "/", fs });
		const specs = root ? readDepsFromPackageJson(root.packageJson) : [];
		const installed = await install(fs, specs, {
			nodeModulesPath: "/node_modules",
			projectName: root?.name ?? "lit-app-fixture",
		});
		checks.push({
			section,
			label: "installed lit and its dependencies",
			status: installed.some((r) => r.name === "lit") ? "pass" : "fail",
			detail: installed.map((r) => `${r.name}@${r.version}`).join(", "),
		});

		setStatus("Bundling the widget…");
		// Mount into the render iframe's `#root` (the committed fixture targets
		// `#app`, so we add a tiny entry instead of editing the fixture).
		await fs.writeFile(
			"/src/render-entry.ts",
			'import "./app-root";\n' +
			'const root = document.getElementById("root");\n' +
			'if (root) root.appendChild(document.createElement("app-root"));\n',
		);
		// Target es2022 (not the default esnext) so esbuild *lowers* the Lit
		// standard decorators + `accessor` fields into runtime code. The render
		// path executes via `new Function`, and no JS engine parses the
		// decorators proposal syntax natively yet — esnext would leave the `@`
		// in place and throw "Invalid or unexpected token" at mount time.
		const { code, css } = await bundle({
			fs,
			entryPoint: "/src/render-entry.ts",
			entryResolveDir: "/",
			options: { format: "esm", platform: "browser", target: "es2022" },
		});
		checks.push({
			section,
			label: "bundled the lit widget",
			status: code.length > 0 ? "pass" : "fail",
			detail: `${code.length} bytes`,
		});

		setStatus("Mounting…");
		const render = createIframeRenderFn(frame);
		const handle = render({ code, css });
		const result = await handle.result;
		checks.push({
			section,
			label: "mounted the live lit widget into a visible iframe",
			status: result.ok ? "pass" : "fail",
			detail: result.ok
				? "rendered"
				: (result.error?.message ?? "render failed"),
		});
		// Intentionally leave the handle open and the iframe in the page so the
		// widget stays live and interactive.
		setStatus(
			result.ok
				? "Live Lit widget mounted below — try the buttons."
				: `Render failed: ${result.error?.message ?? "unknown error"}`,
		);
	} catch (error) {
		const { status, detail } = classifyError(error);
		checks.push({ section, label: "live lit demo", status, detail });
		setStatus(`Skipped: ${detail}`);
	}

	return checks;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(checks: Check[], done: boolean): void {
	const results = document.getElementById("results");
	const summary = document.getElementById("summary");
	if (!results || !summary) return;

	results.innerHTML = "";
	let lastSection = "";
	for (const check of checks) {
		if (check.section !== lastSection) {
			const heading = document.createElement("li");
			heading.className = "section";
			heading.textContent = check.section;
			results.appendChild(heading);
			lastSection = check.section;
		}
		const li = document.createElement("li");
		li.className = check.status;
		li.innerHTML = `<span class="label">${check.label}</span><span class="detail">${check.detail}</span>`;
		results.appendChild(li);
	}

	const passed = checks.filter((c) => c.status === "pass").length;
	const failed = checks.filter((c) => c.status === "fail").length;
	const skipped = checks.filter((c) => c.status === "skip").length;
	const parts = [`${passed} passed`];
	if (failed) parts.push(`${failed} failed`);
	if (skipped) parts.push(`${skipped} skipped`);

	summary.textContent = done
		? parts.join(", ")
		: `Running… (${parts.join(", ")})`;
	summary.className = `summary ${failed ? "fail" : done ? "pass" : ""}`;
}

async function main(): Promise<void> {
	const fs = new MemoryUnionFs(PROJECT);
	const esbuild = createWasmEsbuild({ wasmURL: ESBUILD_WASM_URL });
	const bundle = createBundleFn(esbuild);

	const checks: Check[] = [];
	const sections: Array<() => Promise<Check[]>> = [
		() => typecheckSection(fs),
		() => bundleSection(fs, bundle),
		() => runnerSection(fs, bundle),
		() => renderSection(fs, bundle),
		() => installSection(fs, bundle),
		() => liveDemoSection(bundle),
	];

	render(checks, false);
	for (const section of sections) {
		checks.push(...(await section()));
		render(checks, false);
	}
	render(checks, true);
}

await main();
