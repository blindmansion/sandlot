/**
 * Factory for Sand.fs.* host functions backed by an IFileSystem.
 *
 * Exposes a curated subset of the filesystem interface as async
 * functions under the `Sand.fs` namespace. All functions operate
 * on string paths and string content (no binary/buffer variants).
 */

import type { HostFunction } from "../run/types";
import { defineHostFunction } from "../run/types";
import type { UnionFileSystem } from "../toolchain/types";

export type FsWatchEvent =
	| { type: "write"; path: string }
	| { type: "append"; path: string }
	| { type: "mkdir"; path: string }
	| { type: "rm"; path: string }
	| { type: "cp"; path: string; sourcePath: string }
	| { type: "mv"; path: string; sourcePath: string };

interface FsWatchOptions {
	recursive?: boolean;
}

type FsWatchCallback = ((event: FsWatchEvent) => void) & {
	release?: () => void;
};

interface FsWatcher {
	id: string;
	path: string;
	recursive: boolean;
	callback: FsWatchCallback;
}

function normalizeWatchPath(path: string): string {
	if (path === "/") return path;
	return path.replace(/\/+$/, "");
}

function matchesWatchPath(
	watchedPath: string,
	changedPath: string,
	recursive: boolean,
): boolean {
	if (changedPath === watchedPath) return true;
	if (watchedPath === "/") return recursive;
	return recursive && changedPath.startsWith(`${watchedPath}/`);
}

/**
 * Create the `Sand.fs.*` host functions from a filesystem instance.
 *
 * The returned functions delegate directly to the `IFileSystem` methods.
 * All return types are structured-clone safe, so they work with both
 * the native runner and the worker runner without custom serialization.
 *
 * @example
 * ```ts
 * const hostFunctions = createFsHostFunctions(myFs);
 * // Produces: Sand.fs.readFile, Sand.fs.writeFile, Sand.fs.appendFile,
 * //           Sand.fs.exists, Sand.fs.stat, Sand.fs.readdir,
 * //           Sand.fs.mkdir, Sand.fs.rm, Sand.fs.cp, Sand.fs.mv
 * ```
 */
export function createFsHostFunctions(fs: UnionFileSystem): HostFunction[] {
	const watchers = new Map<string, FsWatcher>();
	let nextWatcherId = 0;

	function emit(event: FsWatchEvent, affectedPaths: string[] = [event.path]) {
		for (const watcher of watchers.values()) {
			if (
				affectedPaths.some((path) =>
					matchesWatchPath(
						watcher.path,
						normalizeWatchPath(path),
						watcher.recursive,
					),
				)
			) {
				try {
					watcher.callback(event);
				} catch {
					// Watch callbacks are notifications; one bad subscriber
					// should not prevent later subscribers from receiving events.
				}
			}
		}
	}

	function deleteWatcher(id: string): boolean {
		const watcher = watchers.get(id);
		if (!watcher) return false;
		watchers.delete(id);
		watcher.callback.release?.();
		return true;
	}

	return [
		defineHostFunction({
			path: ["Sand", "fs", "readFile"],
			fn: (path: string) => fs.readFile(path),
			dts: "(path: string) => Promise<string>",
			doc: "Read a file's contents as UTF-8 text.\n\n@param path Absolute path to the file.\n@returns The file contents.",
		}),

		defineHostFunction({
			path: ["Sand", "fs", "writeFile"],
			fn: async (path: string, content: string) => {
				await fs.writeFile(path, content);
				emit({ type: "write", path });
			},
			dts: "(path: string, content: string) => Promise<void>",
			doc: "Write UTF-8 text to a file, creating or overwriting it.\n\n@param path Absolute path to the file.\n@param content The text to write.",
		}),

		defineHostFunction({
			path: ["Sand", "fs", "exists"],
			fn: (path: string) => fs.exists(path),
			dts: "(path: string) => Promise<boolean>",
			doc: "Check whether a path exists.",
		}),

		defineHostFunction({
			path: ["Sand", "fs", "stat"],
			fn: async (path: string) => {
				const s = await fs.stat(path);
				return {
					isFile: !s.isDirectory && !s.isSymbolicLink,
					isDirectory: s.isDirectory,
					isSymbolicLink: s.isSymbolicLink,
				};
			},
			dts: "(path: string) => Promise<{ isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean; mode: number; size: number }>",
			doc: "Get metadata about a path (file/directory/symlink flags).",
		}),

		defineHostFunction({
			path: ["Sand", "fs", "readdir"],
			fn: (path: string) => fs.readdir(path),
			dts: "(path: string) => Promise<string[]>",
			doc: "List the entry names of a directory.",
		}),

		defineHostFunction({
			path: ["Sand", "fs", "mkdir"],
			fn: async (path: string, options?: { recursive?: boolean }) => {
				await fs.mkdir(path, options);
				emit({ type: "mkdir", path });
			},
			dts: "(path: string, options?: { recursive?: boolean }) => Promise<void>",
			doc: "Create a directory.\n\n@param options Pass `{ recursive: true }` to create parent directories.",
		}),

		defineHostFunction({
			path: ["Sand", "fs", "rm"],
			fn: async (
				path: string,
				options?: { recursive?: boolean; force?: boolean },
			) => {
				await fs.rm(path, options);
				emit({ type: "rm", path });
			},
			dts: "(path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>",
			doc: "Remove a file or directory.\n\n@param options `{ recursive: true }` to remove directories, `{ force: true }` to ignore missing paths.",
		}),

		defineHostFunction({
			path: ["Sand", "fs", "watch"],
			fn: (
				path: string,
				callback: FsWatchCallback,
				options?: FsWatchOptions,
			): string => {
				const id = `fs-watch-${nextWatcherId++}`;
				watchers.set(id, {
					id,
					path: normalizeWatchPath(path),
					recursive: options?.recursive ?? false,
					callback,
				});
				return id;
			},
			dts: '(path: string, callback: (event: { type: "write" | "append" | "mkdir" | "rm" | "cp" | "mv"; path: string; sourcePath?: string }) => void, options?: { recursive?: boolean }) => Promise<string>',
			doc: "Watch a path for changes, invoking `callback` on each event.\n\n@returns A watcher id to pass to `unwatch`.",
		}),

		defineHostFunction({
			path: ["Sand", "fs", "unwatch"],
			fn: (id: string): boolean => deleteWatcher(id),
			dts: "(id: string) => Promise<boolean>",
			doc: "Stop a watcher previously created with `watch`.",
		}),
	];
}
