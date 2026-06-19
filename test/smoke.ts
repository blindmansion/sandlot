/**
 * Smoke demo (NOT a test) showing the mechanics of the test harness and all
 * three library modules wired together end to end.
 *
 * Run it with:
 *
 * ```bash
 * bun test/smoke.ts
 * ```
 *
 * Sections 2 (typecheck) and 4 (install) reach the network — the TypeScript lib
 * CDN and the npm registry respectively. They degrade gracefully and print a
 * warning if offline, so the offline-friendly sections still run.
 */

import * as esbuild from "esbuild";
import { createBundleFn } from "../src/toolchain/bundle";
import { getProjectRoot, install, readDepsFromPackageJson } from "../src/toolchain/install";
import {
	createTypecheckSession,
	formatDiagnostics,
	summarizeDiagnostics,
} from "../src/toolchain/typecheck";
import {
	createWorkspace,
	loadFixture,
	runBundle,
	type Workspace,
} from "./helpers";

// ---------------------------------------------------------------------------
// Tiny console formatting helpers
// ---------------------------------------------------------------------------

function banner(title: string): void {
	const line = "─".repeat(Math.max(0, 70 - title.length - 4));
	console.log(`\n── ${title} ${line}`);
}

function info(label: string, value: unknown): void {
	console.log(`   ${label}:`, value);
}

// ---------------------------------------------------------------------------

async function demoHarness(): Promise<Workspace> {
	banner("1. Harness — load a fixture onto a real, rooted filesystem");

	const ws = await loadFixture("basic");
	info("temp root", ws.root);
	info("all paths", ws.fs.getAllPaths().sort());
	info("package.json", JSON.parse(await ws.fs.readFile("/package.json")).name);

	const stat = await ws.fs.stat("/src/index.ts");
	info("/src/index.ts stat", stat);

	return ws;
}

async function demoTypecheck(ws: Workspace): Promise<void> {
	banner("2. Typecheck — persistent session, incrementally updated (network: libs)");

	const session = createTypecheckSession({
		fs: ws.fs,
		mode: "run",
		compilerOptions: { strict: true },
	});

	try {
		// Clean pass over the committed fixture (first check builds the program).
		const clean = await session.check();
		info("clean fixture errors", summarizeDiagnostics(clean.diagnostics).errorCount);

		// Introduce a type error, tell the session a file was created, re-check.
		await ws.fs.writeFile(
			"/src/bad.ts",
			"export const answer: number = \"not a number\";\n",
		);
		await session.created("/src/bad.ts");
		const dirty = await session.check();
		const dirtySummary = summarizeDiagnostics(dirty.diagnostics);
		info("after adding bad.ts, errors", dirtySummary.errorCount);
		console.log(formatDiagnostics(dirtySummary.all).replace(/^/gm, "     "));

		// Remove the file, notify the session, and confirm the error clears.
		await ws.fs.rm("/src/bad.ts");
		await session.deleted("/src/bad.ts");
		const reclean = await session.check();
		info(
			"after deleting bad.ts, errors",
			summarizeDiagnostics(reclean.diagnostics).errorCount,
		);
	} catch (error) {
		console.warn(
			"   ⚠ skipped (could not load TS libs from CDN):",
			(error as Error).message,
		);
	} finally {
		session.dispose();
	}
}

async function demoBundleAndRun(ws: Workspace): Promise<void> {
	banner("3. Bundle + Run — esbuild the fixture, then execute via the native runner");

	const bundle = createBundleFn(esbuild);

	// Bundle as CommonJS so the native runner can hand back module.exports.
	const cjs = await bundle({
		fs: ws.fs,
		entryPoint: "/src/index.ts",
		entryResolveDir: "/",
		options: { format: "cjs", platform: "neutral" },
	});
	info("cjs bundle bytes", cjs.code.length);
	info("bundle inputs", cjs.inputs);
	info("native deps", cjs.nativeDependencies.modules);

	const ran = await runBundle<{ main(): string }>(cjs.code);
	info("runBundle main()", ran.exports.main());
	info("ok", ran.ok);
}

async function demoInstall(): Promise<Workspace | null> {
	banner("4. Install — resolve + download a real npm package (network: npm)");

	const ws = await loadFixture("app-with-dep");

	const root = await getProjectRoot({ cwd: "/", fs: ws.fs });
	const specs = root ? readDepsFromPackageJson(root.packageJson) : [];
	info("declared deps", specs);

	try {
		const results = await install(ws.fs, specs, {
			nodeModulesPath: "/node_modules",
			projectName: root?.name ?? "app-with-dep",
		});
		info(
			"installed",
			results.map((r) => `${r.name}@${r.version}`),
		);

		// Show the pnpm-style mechanics: a hoisted symlink into the global store.
		const link = "/node_modules/is-number";
		const lstat = await ws.fs.lstat(link);
		info("/node_modules/is-number isSymbolicLink", lstat.isSymbolicLink);
		info("symlink target", await ws.fs.readlink(link));
		info("resolved (realpath)", await ws.fs.realpath(link));

		// The lockfile written next to node_modules.
		const lock = JSON.parse(await ws.fs.readFile("/package-lock.json"));
		info("lockfile packages", Object.keys(lock.packages));

		return ws;
	} catch (error) {
		console.warn(
			"   ⚠ skipped (could not reach npm registry):",
			(error as Error).message,
		);
		await ws.cleanup();
		return null;
	}
}

async function demoIntegration(ws: Workspace): Promise<void> {
	banner("5. Integration — bundle code that imports the installed dependency");

	const bundle = createBundleFn(esbuild);
	const result = await bundle({
		fs: ws.fs,
		entryPoint: "/src/index.ts",
		entryResolveDir: "/",
		options: { format: "cjs", platform: "neutral" },
	});
	info("bundle inputs (incl. node_modules)", result.inputs);

	const ran = await runBundle<{ check(value: unknown): string }>(result.code);
	info("check(21)", ran.exports.check(21));
	info("check('nope')", ran.exports.check("nope"));
	info(
		"captured console",
		ran.log.map((l) => l.text),
	);
}

async function main(): Promise<void> {
	const created: Workspace[] = [];
	// `createWorkspace` is exercised implicitly here to show the empty-workspace
	// entry point exists alongside `loadFixture`.
	const scratch = await createWorkspace("scratch");
	created.push(scratch);

	try {
		const basicWs = await demoHarness();
		created.push(basicWs);

		await demoTypecheck(basicWs);
		await demoBundleAndRun(basicWs);

		const installedWs = await demoInstall();
		if (installedWs) {
			created.push(installedWs);
			await demoIntegration(installedWs);
		}

		banner("Done");
	} finally {
		for (const ws of created) {
			await ws.cleanup();
		}
	}
}

await main();
