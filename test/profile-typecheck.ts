/**
 * Typecheck profiler (NOT a test).
 *
 * Establishes a baseline for the cost of type-checking a *small* project that
 * depends on *large* libraries — the scenario where the typecheck pipeline
 * currently does the most redundant work (re-extracting node_modules and
 * rebuilding the TypeScript program on every call).
 *
 * It loads the `profiling` fixture, installs its dependencies from the npm
 * registry, then measures:
 *
 *   - lib load time (CDN, isolated from per-call cost)
 *   - filesystem size (paths / files / bytes, with a node_modules breakdown)
 *   - a cold typecheck (first run)
 *   - warm typechecks (identical input, repeated)        → steady-state per call
 *   - edit-loop typechecks (mutate a source file each run) → editor scenario
 *
 * Run it with:
 *
 * ```bash
 * bun test/profile-typecheck.ts
 * # or tune the iteration counts:
 * PROFILE_WARM=10 PROFILE_EDITS=10 bun test/profile-typecheck.ts
 * ```
 *
 * Both the install and lib-load steps reach the network; if either is
 * unreachable the script prints a warning and exits without failing.
 */

import { getProjectRoot, install, readDepsFromPackageJson } from "../src/install";
import {
	createTypecheckFn,
	loadLibFilesFromCDN,
	loadTsConfig,
	RENDER_LIBS,
	summarizeDiagnostics,
	type TypecheckArgs,
	type TypecheckFn,
} from "../src/typecheck";
import type { NodeUnionFs } from "./helpers";
import { loadFixture, type Workspace } from "./helpers";

// ---------------------------------------------------------------------------
// Formatting + timing helpers
// ---------------------------------------------------------------------------

const WARM_RUNS = Number(process.env.PROFILE_WARM ?? "5");
const EDIT_RUNS = Number(process.env.PROFILE_EDITS ?? "5");

function banner(title: string): void {
	const line = "─".repeat(Math.max(0, 70 - title.length - 4));
	console.log(`\n── ${title} ${line}`);
}

function info(label: string, value: unknown): void {
	console.log(`   ${label}:`, value);
}

function ms(n: number): string {
	return `${n.toFixed(1)}ms`;
}

function kb(bytes: number): string {
	return `${(bytes / 1024).toFixed(1)} KiB`;
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
	const start = performance.now();
	const result = await fn();
	return [result, performance.now() - start];
}

interface Stats {
	runs: number;
	min: number;
	median: number;
	p95: number;
	max: number;
	mean: number;
}

function summarize(samples: number[]): Stats {
	const sorted = [...samples].sort((a, b) => a - b);
	const sum = sorted.reduce((a, b) => a + b, 0);
	const pct = (p: number): number =>
		sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
	return {
		runs: sorted.length,
		min: sorted[0],
		median: pct(50),
		p95: pct(95),
		max: sorted[sorted.length - 1],
		mean: sum / sorted.length,
	};
}

function reportStats(label: string, stats: Stats): void {
	info(
		label,
		`n=${stats.runs}  min=${ms(stats.min)}  median=${ms(stats.median)}  ` +
			`p95=${ms(stats.p95)}  max=${ms(stats.max)}  mean=${ms(stats.mean)}`,
	);
}

// ---------------------------------------------------------------------------
// Filesystem size breakdown
// ---------------------------------------------------------------------------

interface FsBreakdown {
	totalPaths: number;
	relevantFiles: number;
	relevantBytes: number;
	nodeModulesFiles: number;
	nodeModulesBytes: number;
	dtsFiles: number;
	dtsBytes: number;
}

const RELEVANT_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"];

function isRelevant(path: string): boolean {
	if (path.endsWith(".d.ts")) return true;
	if (path.endsWith("package.json")) return true;
	return RELEVANT_EXT.some((ext) => path.endsWith(ext));
}

async function measureFs(fs: NodeUnionFs): Promise<FsBreakdown> {
	const out: FsBreakdown = {
		totalPaths: 0,
		relevantFiles: 0,
		relevantBytes: 0,
		nodeModulesFiles: 0,
		nodeModulesBytes: 0,
		dtsFiles: 0,
		dtsBytes: 0,
	};

	const paths = fs.getAllPaths();
	out.totalPaths = paths.length;

	await Promise.all(
		paths.map(async (path) => {
			if (path.endsWith("/")) return;
			if (!isRelevant(path)) return;

			let bytes = 0;
			try {
				const stat = await fs.lstat(path);
				if (!stat.isFile) return;
				bytes = (await fs.readFile(path)).length;
			} catch {
				return;
			}

			out.relevantFiles++;
			out.relevantBytes += bytes;

			if (path.includes("/node_modules/")) {
				out.nodeModulesFiles++;
				out.nodeModulesBytes += bytes;
			}
			if (path.endsWith(".d.ts")) {
				out.dtsFiles++;
				out.dtsBytes += bytes;
			}
		}),
	);

	return out;
}

// ---------------------------------------------------------------------------
// Profiling steps
// ---------------------------------------------------------------------------

async function installDeps(ws: Workspace): Promise<boolean> {
	banner("Install — pull the fixture's large dependencies (network: npm)");
	const root = await getProjectRoot({ cwd: "/", fs: ws.fs });
	const specs = root ? readDepsFromPackageJson(root.packageJson) : [];
	info("declared deps", specs);

	try {
		const [results, elapsed] = await timed(() =>
			install(ws.fs, specs, {
				nodeModulesPath: "/node_modules",
				projectName: root?.name ?? "profiling-fixture",
			}),
		);
		info("installed packages", results.length);
		info("install time", ms(elapsed));
		return true;
	} catch (error) {
		console.warn(
			"   ⚠ skipped (could not reach npm registry):",
			(error as Error).message,
		);
		return false;
	}
}

async function run(): Promise<void> {
	banner("Typecheck profiler — small project, large dependencies");
	info("warm runs", WARM_RUNS);
	info("edit-loop runs", EDIT_RUNS);

	const ws = await loadFixture("profiling");
	info("temp root", ws.root);

	try {
		// ── Install dependencies ──────────────────────────────────────────
		if (!(await installDeps(ws))) {
			console.warn("\nCannot profile large-dependency typecheck without deps.");
			return;
		}

		// ── Filesystem size ───────────────────────────────────────────────
		banner("Filesystem — what each typecheck call must enumerate");
		const [fsStats, fsReadTime] = await timed(() => measureFs(ws.fs));
		info(
			"read-all time (extraction proxy)",
			`${ms(fsReadTime)} — paid on every call by extractFilesToMap`,
		);
		info("total paths", fsStats.totalPaths);
		info(
			"relevant files",
			`${fsStats.relevantFiles} (${kb(fsStats.relevantBytes)})`,
		);
		info(
			"in node_modules",
			`${fsStats.nodeModulesFiles} files (${kb(fsStats.nodeModulesBytes)})`,
		);
		info(".d.ts files", `${fsStats.dtsFiles} (${kb(fsStats.dtsBytes)})`);

		// ── Compiler options from the fixture's tsconfig ──────────────────
		const loaded = await loadTsConfig({ cwd: "/", fs: ws.fs }, "/");
		const compilerOptions = loaded?.compilerOptions ?? { strict: true };
		info("tsconfig", loaded?.configPath ?? "(defaults)");

		// ── Lib load (isolated from per-call cost) ────────────────────────
		banner("Lib load — TypeScript lib.*.d.ts from CDN (network)");
		let libMap: Map<string, string>;
		try {
			const [map, elapsed] = await timed(() =>
				loadLibFilesFromCDN(RENDER_LIBS),
			);
			libMap = map;
			info("lib files", libMap.size);
			info("lib load time", ms(elapsed));
		} catch (error) {
			console.warn(
				"   ⚠ skipped (could not load TS libs from CDN):",
				(error as Error).message,
			);
			return;
		}

		// Pre-loaded libs are injected as deps so per-call timings exclude the
		// one-time CDN fetch and isolate the extract + program-build + check cost.
		const typecheck: TypecheckFn = createTypecheckFn({ libMap });

		// Warm up JIT / first program build so the first measured config isn't
		// unfairly penalized.
		const warmup = await typecheck({ fs: ws.fs, mode: "render", compilerOptions });
		info("warmup errors", summarizeDiagnostics(warmup.diagnostics).errorCount);

		// Compare three configurations on the *same* fixture. The getDirectories
		// index applies to all of them; skipLibCheck and includeSuggestions are
		// toggled here so each effect can be read independently.
		const configs: Array<{ label: string; args: TypecheckArgs }> = [
			{
				label: "A. baseline    (skipLibCheck=false, suggestions=on)",
				args: {
					fs: ws.fs,
					mode: "render",
					compilerOptions: { ...compilerOptions, skipLibCheck: false },
					includeSuggestions: true,
				},
			},
			{
				label: "B. skipLibCheck (skipLibCheck=true,  suggestions=on)",
				args: {
					fs: ws.fs,
					mode: "render",
					compilerOptions: { ...compilerOptions, skipLibCheck: true },
					includeSuggestions: true,
				},
			},
			{
				label: "C. errors-only  (skipLibCheck=true,  suggestions=off)",
				args: {
					fs: ws.fs,
					mode: "render",
					compilerOptions: { ...compilerOptions, skipLibCheck: true },
					includeSuggestions: false,
				},
			},
		];

		for (const { label, args } of configs) {
			banner(label);

			// Warm runs (identical input) — steady-state per-call cost.
			const warmSamples: number[] = [];
			let errors = 0;
			for (let i = 0; i < WARM_RUNS; i++) {
				const [result, t] = await timed(() => typecheck(args));
				warmSamples.push(t);
				errors = summarizeDiagnostics(result.diagnostics).errorCount;
			}
			info("errors", errors);
			reportStats("warm", summarize(warmSamples));

			// Edit-loop runs — mutate one source file each iteration (editor loop).
			const editSamples: number[] = [];
			for (let i = 0; i < EDIT_RUNS; i++) {
				await ws.fs.writeFile(
					"/src/edit.ts",
					`export const REVISION_${i} = ${i};\n` +
						`export function touched_${i}(x: number): number { return x + ${i}; }\n`,
				);
				const [, t] = await timed(() => typecheck(args));
				editSamples.push(t);
			}
			await ws.fs.rm("/src/edit.ts");
			reportStats("edit", summarize(editSamples));
		}

		banner("Done");
	} finally {
		await ws.cleanup();
	}
}

await run();
