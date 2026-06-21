/**
 * Browser {@link ExecutionEnv}: pi-agent-core's filesystem + shell capability,
 * backed by the sandlot in-memory VFS and the tiny {@link createBash} shell.
 *
 * pi's contract is strict: every {@link FileSystem}/{@link Shell} method must
 * never throw — all failures are encoded in a returned {@link Result}. The
 * underlying {@link MemoryUnionFs} throws Node-style errors (`ENOENT: ...`), so
 * each method here runs inside {@link wrap}, which maps those into a typed
 * {@link FileError}. Paths may be relative; they resolve against the shared
 * `cwd`, which the `cd` builtin in the shell also mutates.
 */

import {
	type ExecutionEnv,
	ExecutionError,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type Result,
	err,
	ok,
} from "@earendil-works/pi-agent-core";
import { basename, normalize } from "../../../src/toolchain/util";
import { type Bash, createBash } from "./bash";
import type { SandboxCore } from "./sandbox-core";

/** Map a thrown {@link MemoryUnionFs} (Node-style) error to a {@link FileErrorCode}. */
function classify(message: string): FileErrorCode {
	if (message.includes("ENOENT")) return "not_found";
	if (message.includes("ENOTDIR")) return "not_directory";
	if (message.includes("EISDIR")) return "is_directory";
	if (message.includes("EEXIST") || message.includes("ENOTEMPTY")) return "invalid";
	return "unknown";
}

/** Run a fallible filesystem op, mapping any throw into a typed {@link FileError} Result. */
async function wrap<T>(
	path: string | undefined,
	op: () => Promise<T>,
): Promise<Result<T, FileError>> {
	try {
		return ok(await op());
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return err(
			new FileError(
				classify(message),
				message,
				path,
				error instanceof Error ? error : undefined,
			),
		);
	}
}

export interface BrowserEnv extends ExecutionEnv {
	/** The shell used by {@link ExecutionEnv.exec}, exposed so the UI can read `cwd`. */
	readonly bash: Bash;
}

/**
 * Build an {@link ExecutionEnv} over a {@link SandboxCore}. All writes flow
 * through `core.writeFile`/`core.removePath` so the typecheck and bundle
 * sessions stay current; reads/metadata go straight to the VFS.
 */
export function createBrowserEnv(core: SandboxCore): BrowserEnv {
	const fs = core.fs;
	const bash = createBash(core, "/");

	const toAbsolute = (path: string): string =>
		normalize(path.startsWith("/") ? path : `${bash.cwd === "/" ? "" : bash.cwd}/${path}`);

	const env: BrowserEnv = {
		bash,

		get cwd() {
			return bash.cwd;
		},
		set cwd(value: string) {
			bash.setCwd(value);
		},

		async absolutePath(path) {
			return ok(toAbsolute(path));
		},

		async joinPath(parts) {
			return ok(normalize(parts.join("/")));
		},

		async readTextFile(path) {
			return wrap(path, () => fs.readFile(toAbsolute(path)));
		},

		async readTextLines(path, options) {
			return wrap(path, async () => {
				const text = await fs.readFile(toAbsolute(path));
				const lines = text.split("\n");
				return options?.maxLines !== undefined
					? lines.slice(0, options.maxLines)
					: lines;
			});
		},

		async readBinaryFile(path) {
			return wrap(path, () => fs.readFileBuffer(toAbsolute(path)));
		},

		async writeFile(path, content) {
			return wrap(path, async () => {
				const text =
					typeof content === "string" ? content : new TextDecoder().decode(content);
				await core.writeFile(toAbsolute(path), text);
			});
		},

		async appendFile(path, content) {
			return wrap(path, async () => {
				const abs = toAbsolute(path);
				const existing = (await fs.exists(abs)) ? await fs.readFile(abs) : "";
				const text =
					typeof content === "string" ? content : new TextDecoder().decode(content);
				await core.writeFile(abs, existing + text);
			});
		},

		async fileInfo(path) {
			return wrap(path, async () => {
				const abs = toAbsolute(path);
				const stat = await fs.lstat(abs);
				const kind = stat.isDirectory
					? "directory"
					: stat.isSymbolicLink
						? "symlink"
						: "file";
				let size = 0;
				if (kind === "file") {
					size = (await fs.readFileBuffer(abs)).byteLength;
				}
				const info: FileInfo = {
					name: basename(abs),
					path: abs,
					kind,
					size,
					mtimeMs: 0,
				};
				return info;
			});
		},

		async listDir(path) {
			return wrap(path, async () => {
				const abs = toAbsolute(path);
				const names = await fs.readdir(abs);
				const infos: FileInfo[] = [];
				for (const name of names) {
					const childPath = abs === "/" ? `/${name}` : `${abs}/${name}`;
					const stat = await fs.lstat(childPath);
					const kind = stat.isDirectory
						? "directory"
						: stat.isSymbolicLink
							? "symlink"
							: "file";
					infos.push({
						name,
						path: childPath,
						kind,
						size: kind === "file" ? (await fs.readFileBuffer(childPath)).byteLength : 0,
						mtimeMs: 0,
					});
				}
				return infos;
			});
		},

		async canonicalPath(path) {
			return wrap(path, () => fs.realpath(toAbsolute(path)));
		},

		async exists(path) {
			return ok(await fs.exists(toAbsolute(path)));
		},

		async createDir(path, options) {
			return wrap(path, () =>
				fs.mkdir(toAbsolute(path), { recursive: options?.recursive ?? true }),
			);
		},

		async remove(path, options) {
			return wrap(path, () =>
				core.removePath(toAbsolute(path), {
					recursive: options?.recursive ?? false,
					force: options?.force ?? false,
				}),
			);
		},

		async createTempDir(prefix = "tmp-") {
			return wrap(undefined, async () => {
				const dir = `/tmp/${prefix}${Math.random().toString(36).slice(2)}`;
				await fs.mkdir(dir, { recursive: true });
				return dir;
			});
		},

		async createTempFile(options) {
			return wrap(undefined, async () => {
				const name = `${options?.prefix ?? ""}${Math.random().toString(36).slice(2)}${
					options?.suffix ?? ""
				}`;
				const path = `/tmp/${name}`;
				await core.writeFile(path, "");
				return path;
			});
		},

		cleanup(): Promise<void> {
			// In-memory VFS owns no external resources.
			return Promise.resolve();
		},

		async exec(command, options) {
			if (options?.abortSignal?.aborted) {
				return err(new ExecutionError("aborted", "Command aborted before start"));
			}
			try {
				const result = await bash.exec(command, options?.abortSignal);
				options?.onStdout?.(result.stdout);
				options?.onStderr?.(result.stderr);
				return ok(result);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return err(new ExecutionError("unknown", message));
			}
		},
	};

	return env;
}
