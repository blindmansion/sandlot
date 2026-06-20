/**
 * In-memory implementation of the *union* of the three module filesystem
 * interfaces — {@link InstallFileSystem}, {@link BundleFileSystem} and
 * {@link TypecheckFileSystem} — so a single instance can be handed to any of
 * them. It is the browser-friendly counterpart to the on-disk `NodeUnionFs`
 * used in tests: no `node:fs`, just a flat `Map` of normalized POSIX paths to
 * entries, which makes it safe to run inside a bundle in the browser.
 *
 * Supports files, directories, and symlinks. All paths live under a single
 * virtual root (`/`).
 *
 * ```ts
 * const fs = new MemoryUnionFs({ "/package.json": '{ "name": "app" }' });
 * await fs.writeFile("/src/index.ts", "export const x = 1;\n");
 * ```
 */

import type { BundleFileSystem } from "../../src/toolchain/bundle/fs";
import type {
	FileContent,
	InstallFileSystem,
	InstallMkdirOptions,
	InstallRmOptions,
} from "../../src/toolchain/install/fs";
import type { TypecheckFileSystem } from "../../src/toolchain/typecheck/fs";
import { dirname, isAbsolute, normalize } from "../../src/toolchain/util";

/**
 * The superset stat shape. It carries every field any of the three module stat
 * interfaces ask for, which makes it structurally assignable to all of them.
 */
export interface UnionFileStat {
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

type Entry =
	| { type: "file"; content: Uint8Array }
	| { type: "directory" }
	| { type: "symlink"; target: string };

const MAX_SYMLINK_DEPTH = 40;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Normalize to an absolute POSIX path with no trailing slash (except root). */
function cleanPath(path: string): string {
	const norm = normalize(isAbsolute(path) ? path : `/${path}`);
	if (norm.length > 1 && norm.endsWith("/")) return norm.slice(0, -1);
	return norm;
}

function toBytes(content: FileContent): Uint8Array {
	return typeof content === "string" ? encoder.encode(content) : content;
}

/**
 * In-memory implementation of the combined module FS surface.
 *
 * @see {@link InstallFileSystem}
 * @see {@link BundleFileSystem}
 * @see {@link TypecheckFileSystem}
 */
export class MemoryUnionFs
	implements InstallFileSystem, BundleFileSystem, TypecheckFileSystem {
	private data = new Map<string, Entry>();

	constructor(initialFiles?: Record<string, FileContent>) {
		this.data.set("/", { type: "directory" });
		if (initialFiles) {
			for (const [path, content] of Object.entries(initialFiles)) {
				const norm = cleanPath(path);
				this.ensureParents(norm);
				this.data.set(norm, { type: "file", content: toBytes(content) });
			}
		}
	}

	// ------------------------------------------------------------------
	// Path resolution (symlink-aware)
	// ------------------------------------------------------------------

	private ensureParents(path: string): void {
		const dir = dirname(path);
		if (dir === "/" || dir === path) return;
		if (!this.data.has(dir)) {
			this.ensureParents(dir);
			this.data.set(dir, { type: "directory" });
		}
	}

	/** Resolve every symlink in `path`, returning the canonical absolute path. */
	private resolve(path: string): string {
		const norm = cleanPath(path);
		if (norm === "/") return "/";
		let resolved = "";
		const seen = new Set<string>();
		for (const part of norm.slice(1).split("/")) {
			resolved = `${resolved}/${part}`;
			let depth = 0;
			let entry = this.data.get(resolved);
			while (entry?.type === "symlink" && depth < MAX_SYMLINK_DEPTH) {
				if (seen.has(resolved)) {
					throw new Error(
						`ELOOP: too many levels of symbolic links, '${path}'`,
					);
				}
				seen.add(resolved);
				const { target } = entry;
				resolved = target.startsWith("/")
					? cleanPath(target)
					: cleanPath(`${dirname(resolved)}/${target}`);
				entry = this.data.get(resolved);
				depth++;
			}
			if (depth >= MAX_SYMLINK_DEPTH) {
				throw new Error(`ELOOP: too many levels of symbolic links, '${path}'`);
			}
		}
		return resolved;
	}

	/** Resolve symlinks in every segment *except* the final one (for lstat). */
	private resolveParent(path: string): string {
		const norm = cleanPath(path);
		if (norm === "/") return "/";
		const parts = norm.slice(1).split("/");
		if (parts.length <= 1) return norm;
		const parentDir = this.resolve(dirname(norm));
		return parentDir === "/"
			? `/${parts[parts.length - 1]}`
			: `${parentDir}/${parts[parts.length - 1]}`;
	}

	// ------------------------------------------------------------------
	// Reads
	// ------------------------------------------------------------------

	async readFile(path: string): Promise<string> {
		return decoder.decode(await this.readFileBuffer(path));
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const entry = this.data.get(this.resolve(path));
		if (!entry) {
			throw new Error(`ENOENT: no such file or directory, open '${path}'`);
		}
		if (entry.type !== "file") {
			throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
		}
		return entry.content;
	}

	async exists(path: string): Promise<boolean> {
		try {
			return this.data.has(this.resolve(path));
		} catch {
			return false;
		}
	}

	async stat(path: string): Promise<UnionFileStat> {
		const entry = this.data.get(this.resolve(path));
		if (!entry) {
			throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
		}
		// `stat` follows symlinks, so the resolved entry is never a symlink.
		return {
			isFile: entry.type === "file",
			isDirectory: entry.type === "directory",
			isSymbolicLink: false,
		};
	}

	async lstat(path: string): Promise<UnionFileStat> {
		const entry = this.data.get(this.resolveParent(path));
		if (!entry) {
			throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
		}
		return {
			isFile: entry.type === "file",
			isDirectory: entry.type === "directory",
			isSymbolicLink: entry.type === "symlink",
		};
	}

	async readdir(path: string): Promise<string[]> {
		const norm = this.resolve(path);
		const entry = this.data.get(norm);
		if (!entry) {
			throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
		}
		if (entry.type !== "directory") {
			throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
		}
		const prefix = norm === "/" ? "/" : `${norm}/`;
		const names = new Set<string>();
		for (const p of this.data.keys()) {
			if (p !== norm && p.startsWith(prefix)) {
				const name = p.slice(prefix.length).split("/")[0];
				if (name) names.add(name);
			}
		}
		return [...names].sort();
	}

	async readlink(path: string): Promise<string> {
		const entry = this.data.get(this.resolveParent(path));
		if (!entry) {
			throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
		}
		if (entry.type !== "symlink") {
			throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
		}
		return entry.target;
	}

	async realpath(path: string): Promise<string> {
		const resolved = this.resolve(path);
		if (!this.data.has(resolved)) {
			throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
		}
		return resolved;
	}

	/**
	 * Enumerate every entry (files, directories, and symlinks) as virtual paths.
	 * Used by the type-checker to discover source files. The root is omitted.
	 */
	getAllPaths(): string[] {
		const out: string[] = [];
		for (const p of this.data.keys()) {
			if (p !== "/") out.push(p);
		}
		return out;
	}

	// ------------------------------------------------------------------
	// Writes
	// ------------------------------------------------------------------

	async writeFile(path: string, content: FileContent): Promise<void> {
		const norm = this.resolve(path);
		const existing = this.data.get(norm);
		if (existing && existing.type === "directory") {
			throw new Error(`EISDIR: illegal operation on a directory, open '${path}'`);
		}
		this.ensureParents(norm);
		this.data.set(norm, { type: "file", content: toBytes(content) });
	}

	async mkdir(path: string, options?: InstallMkdirOptions): Promise<void> {
		const norm = cleanPath(path);
		const existing = this.data.get(norm);
		if (existing) {
			if (existing.type !== "directory") {
				throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
			}
			if (!options?.recursive) {
				throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
			}
			return;
		}
		const parent = dirname(norm);
		if (parent !== "/" && !this.data.has(parent)) {
			if (options?.recursive) {
				await this.mkdir(parent, { recursive: true });
			} else {
				throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
			}
		}
		this.data.set(norm, { type: "directory" });
	}

	async rm(path: string, options?: InstallRmOptions): Promise<void> {
		const norm = cleanPath(path);
		const entry = this.data.get(norm);
		if (!entry) {
			if (options?.force) return;
			throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
		}
		if (entry.type === "directory") {
			const prefix = norm === "/" ? "/" : `${norm}/`;
			const hasChildren = [...this.data.keys()].some((p) =>
				p.startsWith(prefix),
			);
			if (hasChildren && !options?.recursive) {
				throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
			}
			for (const p of [...this.data.keys()]) {
				if (p.startsWith(prefix)) this.data.delete(p);
			}
		}
		this.data.delete(norm);
	}

	async symlink(target: string, linkPath: string): Promise<void> {
		const norm = cleanPath(linkPath);
		if (this.data.has(norm)) {
			throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
		}
		this.ensureParents(norm);
		this.data.set(norm, { type: "symlink", target });
	}
}
