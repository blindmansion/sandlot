/**
 * Persistent, incremental type-checking session.
 *
 * Owns a long-lived `VirtualTypeScriptEnvironment` so dependency `.d.ts` and lib
 * files are parsed/bound once. The caller mutates its filesystem and then tells
 * the session what changed; only the affected project files are reparsed, while
 * everything else (libs + node_modules) is reused from the cached program.
 */

import {
	addToDirectoryIndex,
	type BuiltEnv,
	buildEnv,
} from "./environment";
import type { TypecheckFileSystem } from "./fs";
import { loadLibFilesFromCDN, RENDER_LIBS, RUN_LIBS } from "./lib-loader";
import { getAllDiagnostics } from "./services";
import type {
	FileChange,
	TypecheckResult,
	TypecheckSession,
	TypecheckSessionOptions,
} from "./types";

// ---------------------------------------------------------------------------
// Lib file loading
// ---------------------------------------------------------------------------

// Module-level lib cache. Lib files are pinned to a TypeScript version and are
// identical across sessions, so sharing them is safe and avoids refetching.
const libCache = new Map<string, Map<string, string>>();
const libPromises = new Map<string, Promise<Map<string, string>>>();

async function getOrLoadLibs(
	mode: "run" | "render",
): Promise<Map<string, string>> {
	const cached = libCache.get(mode);
	if (cached) return cached;

	const existing = libPromises.get(mode);
	if (existing) return existing;

	const libs = mode === "run" ? RUN_LIBS : RENDER_LIBS;
	const promise = (async () => {
		const libMap = await loadLibFilesFromCDN(libs);
		libCache.set(mode, libMap);
		return libMap;
	})();

	libPromises.set(mode, promise);
	return promise;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** A non-node_modules TypeScript source file (a project file we manage as a root). */
function isProjectFile(path: string): boolean {
	if (path.includes("/node_modules/")) return false;
	return path.endsWith(".ts") || path.endsWith(".tsx");
}

class Session implements TypecheckSession {
	private readonly fs: TypecheckFileSystem;
	private readonly options: TypecheckSessionOptions;
	private readonly mode: "run" | "render";

	private built: BuiltEnv | null = null;
	private rootSet = new Set<string>();
	private libMap: Map<string, string> | null;

	constructor(options: TypecheckSessionOptions) {
		this.fs = options.fs;
		this.options = options;
		this.mode = options.mode ?? "render";
		this.libMap = options.libMap ?? null;
	}

	async check(): Promise<TypecheckResult> {
		const built = await this.ensureBuilt();
		const diagnostics = getAllDiagnostics(
			built.env,
			built.rootFiles,
			this.options.includeSuggestions ?? true,
		);
		// `ensureBuilt` guarantees the lib map is loaded.
		const libMap = this.libMap ?? new Map<string, string>();
		return { diagnostics, libMap };
	}

	async changed(path: string, content?: string): Promise<void> {
		await this.apply([{ type: "change", path, content }]);
	}

	async created(path: string, content?: string): Promise<void> {
		await this.apply([{ type: "create", path, content }]);
	}

	async deleted(path: string): Promise<void> {
		await this.apply([{ type: "delete", path }]);
	}

	async apply(changes: FileChange[]): Promise<void> {
		// Before the first build there is no program to update; the next `check()`
		// reads the filesystem fresh, so pending changes are already reflected.
		if (!this.built) return;
		const built = this.built;

		for (const change of changes) {
			// Dependency changes (and non-source files like package.json/tsconfig)
			// can't be applied incrementally — rebuild on the next check. The fresh
			// build reads the filesystem, picking up every remaining change too.
			if (!isProjectFile(change.path)) {
				this.invalidate();
				return;
			}

			if (change.type === "delete") {
				if (this.rootSet.has(change.path)) {
					built.env.deleteFile(change.path);
					this.rootSet.delete(change.path);
					const idx = built.rootFiles.indexOf(change.path);
					if (idx !== -1) built.rootFiles.splice(idx, 1);
				}
				continue;
			}

			const content = change.content ?? (await this.fs.readFile(change.path));
			if (this.rootSet.has(change.path)) {
				// Existing file -> incremental reparse.
				built.env.updateFile(change.path, content);
			} else {
				// New file -> add as a root and make resolution aware of its dir.
				built.env.createFile(change.path, content);
				built.rootFiles.push(change.path);
				this.rootSet.add(change.path);
				addToDirectoryIndex(built.directoryIndex, change.path);
			}
		}
	}

	invalidate(): void {
		this.built = null;
		this.rootSet = new Set();
	}

	dispose(): void {
		this.invalidate();
	}

	private async ensureBuilt(): Promise<BuiltEnv> {
		if (this.built) return this.built;

		if (!this.libMap) {
			this.libMap = await getOrLoadLibs(this.mode);
		}

		const built = await buildEnv(this.fs, this.libMap, {
			compilerOptions: this.options.compilerOptions,
			workingDirectory: this.options.workingDirectory,
			rootFiles: this.options.rootFiles,
		});
		this.built = built;
		this.rootSet = new Set(built.rootFiles);
		return built;
	}
}

/**
 * Create a stateful, incremental type-checking session.
 *
 * @example
 * ```ts
 * const session = createTypecheckSession({ fs, mode: "render", compilerOptions });
 * await session.check();                         // first call builds the program
 * await session.changed("/src/index.ts", next);  // incremental reparse
 * await session.check();                         // reuses cached node_modules/libs
 * session.dispose();
 * ```
 */
export function createTypecheckSession(
	options: TypecheckSessionOptions,
): TypecheckSession {
	return new Session(options);
}

/**
 * One-shot convenience: build a session, run a single `check()`, and dispose.
 * Use a session directly when you need repeated checks.
 */
export async function runTypecheck(
	options: TypecheckSessionOptions,
): Promise<TypecheckResult> {
	const session = createTypecheckSession(options);
	try {
		return await session.check();
	} finally {
		session.dispose();
	}
}
