/**
 * Bundle profiler (NOT a test).
 *
 * Establishes a baseline for the cost of bundling a *small* project that pulls
 * in *large* dependencies — the scenario where the bundler's esbuild plugin does
 * the most work resolving and loading files out of `node_modules` through the
 * async `BundleFileSystem` interface.
 *
 * It loads the `profiling` fixture (the same small-project/large-deps fixture the
 * typecheck profiler uses: `lodash` + `@types/lodash`, `rxjs`, `zod`), installs
 * its dependencies from the npm registry, then measures:
 *
 *   - esbuild engine startup (native module import vs wasm initialize), isolated
 *     from per-build cost
 *   - filesystem size (paths / files / bytes, with a node_modules breakdown)
 *   - filesystem *chattiness* — how many exists/stat/readFile calls the plugin
 *     makes per build, and per bundled input (the suspected hot path)
 *   - a cold bundle (first run)
 *   - warm bundles (identical input, repeated)        → steady-state per call
 *   - edit-loop bundles (mutate a source file each run) → editor scenario
 *
 * Both native esbuild and esbuild-wasm are profiled. They share the same
 * filesystem plugin, so comparing them isolates raw engine cost from the
 * plugin/FS round-trip cost (which dominates the browser/wasm path).
 *
 * Run it with:
 *
 * ```bash
 * bun test/profile-bundle.ts
 * # or tune the iteration counts:
 * PROFILE_WARM=10 PROFILE_EDITS=10 bun test/profile-bundle.ts
 * # or skip the wasm section (native only):
 * PROFILE_WASM=0 bun test/profile-bundle.ts
 * ```
 *
 * The install step reaches the network; if the npm registry is unreachable the
 * script prints a warning and exits without failing.
 */

import * as esbuildNative from "esbuild";
import {
	type BundleArgs,
	type BundleFn,
	type BundleResult,
	createBundleFn,
	createWasmEsbuild,
	type EsbuildAPI,
} from "../src/bundle";
import type { BundleFileSystem } from "../src/bundle/fs";
import { getProjectRoot, install, readDepsFromPackageJson } from "../src/install";
import type { NodeUnionFs } from "./helpers";
import { loadFixture, type Workspace } from "./helpers";

// ---------------------------------------------------------------------------
// Formatting + timing helpers
// ---------------------------------------------------------------------------

const WARM_RUNS = Number(process.env.PROFILE_WARM ?? "5");
const EDIT_RUNS = Number(process.env.PROFILE_EDITS ?? "5");
const PROFILE_WASM = process.env.PROFILE_WASM !== "0";

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
	const n = sorted.length;
	const sum = sorted.reduce((a, b) => a + b, 0);
	const at = (idx: number): number =>
		sorted[Math.max(0, Math.min(n - 1, idx))] ?? 0;
	const pct = (p: number): number => at(Math.floor((p / 100) * n));
	return {
		runs: n,
		min: at(0),
		median: pct(50),
		p95: pct(95),
		max: at(n - 1),
		mean: n === 0 ? 0 : sum / n,
	};
}

function reportStats(label: string, stats: Stats): void {
	info(
		label,
		`n=${stats.runs}  min=${ms(stats.min)}  median=${ms(stats.median)}  ` +
			`p95=${ms(stats.p95)}  max=${ms(stats.max)}  mean=${ms(stats.mean)}`,
	);
}

/** Stable signature of a bundle result, for cross-run equality checks. */
function bundleSignature(result: BundleResult): string {
	return `${result.code.length}:${[...result.inputs].sort().join("|")}`;
}

// ---------------------------------------------------------------------------
// Filesystem instrumentation
//
// Wraps a BundleFileSystem in a counting proxy so we can see how many FS reads
// the esbuild plugin issues per build. The plugin resolves each import by
// probing extensions (exists + stat per candidate) and walking node_modules, so
// this ratio is the clearest signal of resolution overhead — and it is paid on
// the *wrong* side of the wasm boundary in the browser.
// ---------------------------------------------------------------------------

interface FsCounters {
	exists: number;
	stat: number;
	readFile: number;
	readFileBuffer: number;
}

const COUNTED_METHODS = new Set<keyof FsCounters>([
	"exists",
	"stat",
	"readFile",
	"readFileBuffer",
]);

interface CountingFs {
	fs: BundleFileSystem;
	counters: FsCounters;
	reset(): void;
}

function createCountingFs(target: BundleFileSystem): CountingFs {
	const counters: FsCounters = {
		exists: 0,
		stat: 0,
		readFile: 0,
		readFileBuffer: 0,
	};

	const proxy = new Proxy(target, {
		get(obj, prop, receiver) {
			const value = Reflect.get(obj, prop, receiver);
			if (typeof value !== "function") return value;
			if (COUNTED_METHODS.has(prop as keyof FsCounters)) {
				return (...args: unknown[]) => {
					counters[prop as keyof FsCounters]++;
					return (value as (...a: unknown[]) => unknown).apply(obj, args);
				};
			}
			return (value as (...a: unknown[]) => unknown).bind(obj);
		},
	}) as unknown as BundleFileSystem;

	return {
		fs: proxy,
		counters,
		reset() {
			counters.exists = 0;
			counters.stat = 0;
			counters.readFile = 0;
			counters.readFileBuffer = 0;
		},
	};
}

function reportFsCounts(counters: FsCounters, inputs: number): void {
	const total =
		counters.exists +
		counters.stat +
		counters.readFile +
		counters.readFileBuffer;
	info(
		"fs calls / build",
		`total=${total}  exists=${counters.exists}  stat=${counters.stat}  ` +
			`readFile=${counters.readFile}  readFileBuffer=${counters.readFileBuffer}`,
	);
	const per = (n: number): string => (inputs ? (n / inputs).toFixed(1) : "—");
	info(
		"fs calls / bundled input",
		`inputs=${inputs}  total/in=${per(total)}  exists/in=${per(counters.exists)}  ` +
			`stat/in=${per(counters.stat)}`,
	);
}

// ---------------------------------------------------------------------------
// Filesystem size breakdown (proxy for how much node_modules the plugin can see)
// ---------------------------------------------------------------------------

interface FsBreakdown {
	totalPaths: number;
	relevantFiles: number;
	relevantBytes: number;
	nodeModulesFiles: number;
	nodeModulesBytes: number;
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

/** Source for the file mutated in the edit loop (a real, reachable module). */
function editContent(i: number): string {
	return (
		`export const REVISION_${i} = ${i};\n` +
		`export function touched_${i}(x: number): number { return x + ${i}; }\n`
	);
}

/**
 * Run cold + warm + edit-loop bundles against a given esbuild engine and report
 * the timings, output shape, and FS chattiness. Returns the warm/edit medians so
 * callers can build a cross-engine comparison.
 */
async function profileEngine(
	name: string,
	bundle: BundleFn,
	counting: CountingFs,
	args: BundleArgs,
	editPath: string,
): Promise<{ warm: Stats; edit: Stats }> {
	banner(`${name} — createBundleFn() runs a fresh build every call`);

	// Cold: first build also pays one-time engine/JIT warmup.
	counting.reset();
	const [cold, coldTime] = await timed(() => bundle(args));
	const coldCounters = { ...counting.counters };
	info("cold first build", ms(coldTime));
	info("output", `${kb(cold.code.length)} js, ${cold.inputs.length} inputs`);
	info("native deps", cold.nativeDependencies.modules);
	reportFsCounts(coldCounters, cold.inputs.length);

	const coldSig = bundleSignature(cold);

	// Warm: identical input, repeated. With no persistent context this is the
	// steady-state cost of a full rebuild.
	const warm: number[] = [];
	let warmMismatches = 0;
	for (let i = 0; i < WARM_RUNS; i++) {
		const [result, t] = await timed(() => bundle(args));
		warm.push(t);
		if (bundleSignature(result) !== coldSig) warmMismatches++;
	}
	reportStats("warm", summarize(warm));
	info(
		"output stable across warm runs",
		warmMismatches === 0 ? "yes" : `NO (${warmMismatches} mismatches)`,
	);

	// Edit loop: mutate a reachable source file each iteration, rebuild.
	const edit: number[] = [];
	for (let i = 0; i < EDIT_RUNS; i++) {
		await args.fs.writeFile(editPath, editContent(i));
		const [, t] = await timed(() => bundle(args));
		edit.push(t);
	}
	await args.fs.writeFile(editPath, editContent(0));
	reportStats("edit", summarize(edit));

	return { warm: summarize(warm), edit: summarize(edit) };
}

function loadWasmEngine(): EsbuildAPI | null {
	try {
		// Under Node/Bun, initialize() loads the package's bundled esbuild.wasm
		// itself; the wasmURL/wasmModule options are browser-only. worker:false
		// keeps it on this thread so timings reflect raw build CPU without
		// postMessage overhead (a real browser would run it in a worker).
		return createWasmEsbuild({ worker: false });
	} catch (error) {
		console.warn("   ⚠ wasm engine unavailable:", (error as Error).message);
		return null;
	}
}

async function run(): Promise<void> {
	banner("Bundle profiler — small project, large dependencies");
	info("warm runs", WARM_RUNS);
	info("edit-loop runs", EDIT_RUNS);
	info("profile wasm", PROFILE_WASM);

	const ws = await loadFixture("profiling");
	info("temp root", ws.root);

	try {
		// ── Install dependencies ──────────────────────────────────────────
		if (!(await installDeps(ws))) {
			console.warn("\nCannot profile large-dependency bundling without deps.");
			return;
		}

		// ── Wire an edit-loop file into the entry's import graph ───────────
		// Bundling only includes files reachable from the entry point, so the
		// edited module must be imported. We add a side-effect import once.
		const editPath = "/src/edit.ts";
		await ws.fs.writeFile(editPath, editContent(0));
		const indexPath = "/src/index.ts";
		const originalIndex = await ws.fs.readFile(indexPath);
		await ws.fs.writeFile(indexPath, `import "./edit";\n${originalIndex}`);

		// ── Filesystem size ───────────────────────────────────────────────
		banner("Filesystem — what the resolver can reach");
		const [fsStats, fsReadTime] = await timed(() => measureFs(ws.fs));
		info("read-all time", ms(fsReadTime));
		info("total paths", fsStats.totalPaths);
		info(
			"relevant files",
			`${fsStats.relevantFiles} (${kb(fsStats.relevantBytes)})`,
		);
		info(
			"in node_modules",
			`${fsStats.nodeModulesFiles} files (${kb(fsStats.nodeModulesBytes)})`,
		);

		// Shared bundle inputs. A counting FS wraps the workspace so we can
		// observe plugin chattiness; platform "node" externalizes builtins and
		// bundles the npm deps in.
		const counting = createCountingFs(ws.fs);
		const args: BundleArgs = {
			fs: counting.fs,
			entryPoint: indexPath,
			entryResolveDir: "/",
			options: { format: "esm", platform: "node" },
		};

		// ── Engine startup (isolated from per-build cost) ──────────────────
		banner("Engine startup — one-time esbuild init");
		const [nativeEngine, nativeInit] = await timed(async () => {
			// Touch the native API once so the import/transform service is up.
			await esbuildNative.version;
			return esbuildNative as unknown as EsbuildAPI;
		});
		info("native init", ms(nativeInit));

		let wasmEngine: EsbuildAPI | null = null;
		let wasmInit = 0;
		if (PROFILE_WASM) {
			const loaded = loadWasmEngine();
			if (loaded) {
				// First build triggers initialize(); time that explicitly via a
				// throwaway build so the cold-build number below is comparable.
				[, wasmInit] = await timed(async () => {
					try {
						await loaded.build({
							stdin: { contents: "export const x = 1;" },
							write: false,
							bundle: false,
						});
					} catch {
						// ignore — we only want to pay the initialize() cost here
					}
				});
				wasmEngine = loaded;
				info("wasm init (incl. initialize())", ms(wasmInit));
			}
		}

		// ── Native engine ──────────────────────────────────────────────────
		const nativeBundle = createBundleFn(nativeEngine);
		const nativeResult = await profileEngine(
			"Native esbuild",
			nativeBundle,
			counting,
			args,
			editPath,
		);

		// ── Wasm engine ──────────────────────────────────────────────────────
		let wasmStats: { warm: Stats; edit: Stats } | null = null;
		if (wasmEngine) {
			const wasmBundle = createBundleFn(wasmEngine);
			wasmStats = await profileEngine(
				"Wasm esbuild",
				wasmBundle,
				counting,
				args,
				editPath,
			);
		}

		// ── Comparison summary ─────────────────────────────────────────────
		if (wasmStats) {
			banner("Native vs wasm (median, same plugin + FS)");
			info(
				"warm",
				`native ${ms(nativeResult.warm.median)} vs wasm ${ms(
					wasmStats.warm.median,
				)} → ${(wasmStats.warm.median / nativeResult.warm.median).toFixed(1)}x`,
			);
			info(
				"edit",
				`native ${ms(nativeResult.edit.median)} vs wasm ${ms(
					wasmStats.edit.median,
				)} → ${(wasmStats.edit.median / nativeResult.edit.median).toFixed(1)}x`,
			);
		}

		banner("Done");
	} finally {
		await ws.cleanup();
	}
}

await run();
