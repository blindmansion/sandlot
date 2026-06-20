/**
 * A real, on-disk filesystem implementation backed by standard Node/Bun
 * (`node:fs`) APIs.
 *
 * It implements the *union* of the three minimal filesystem interfaces the
 * library modules depend on — {@link InstallFileSystem}, {@link BundleFileSystem}
 * and {@link TypecheckFileSystem} — so a single instance can be handed to any of
 * them in tests.
 *
 * Unlike an in-memory filesystem, this maps an abstract POSIX "virtual" root
 * (`/`) onto a real directory on disk (`root`). Every virtual path like
 * `/package.json` or `/.store/lodash/...` is resolved relative to that real
 * directory, so the modules can use absolute paths exactly as they would in a
 * browser sandbox while we run against the actual filesystem.
 */

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import type { BundleFileSystem } from "../../src/toolchain/bundle/fs";
import type {
	FileContent,
	InstallFileSystem,
	InstallMkdirOptions,
	InstallRmOptions,
} from "../../src/toolchain/install/fs";
import type { TypecheckFileSystem } from "../../src/toolchain/typecheck/fs";
import { isAbsolute, normalize } from "../../src/toolchain/util";

/**
 * The superset stat shape. It carries every field any of the three module stat
 * interfaces ask for, which makes it structurally assignable to all of them.
 */
export interface UnionFileStat {
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

function toUnionStat(stats: fsSync.Stats): UnionFileStat {
	return {
		isFile: stats.isFile(),
		isDirectory: stats.isDirectory(),
		isSymbolicLink: stats.isSymbolicLink(),
	};
}

/**
 * Real-filesystem implementation of the combined module FS surface.
 *
 * @see {@link InstallFileSystem}
 * @see {@link BundleFileSystem}
 * @see {@link TypecheckFileSystem}
 */
export class NodeUnionFs
	implements InstallFileSystem, BundleFileSystem, TypecheckFileSystem {
	/** Absolute real path that the virtual root (`/`) maps onto. */
	readonly root: string;

	constructor(root: string) {
		const resolved = nodePath.resolve(root);
		// Canonicalize so `realpath`/`readlink` round-trips back to virtual paths.
		// On some platforms (e.g. macOS temp dirs) the root sits behind a symlink
		// like /var -> /private/var; without this, resolved real paths wouldn't
		// share a prefix with `root`.
		try {
			this.root = fsSync.realpathSync(resolved);
		} catch {
			this.root = resolved;
		}
	}

	// ------------------------------------------------------------------
	// Path mapping
	// ------------------------------------------------------------------

	/** Map a virtual POSIX path onto its real on-disk path. */
	private toReal(virtualPath: string): string {
		const abs = isAbsolute(virtualPath) ? virtualPath : `/${virtualPath}`;
		const norm = normalize(abs);
		const rel = norm === "/" ? "" : norm.slice(1);
		return nodePath.join(this.root, rel);
	}

	/**
	 * Map a real on-disk path back to its virtual POSIX path. Paths that fall
	 * outside the root are returned unchanged.
	 */
	private toVirtual(realPath: string): string {
		const rel = nodePath.relative(this.root, nodePath.resolve(realPath));
		if (rel === "") return "/";
		if (rel.startsWith("..")) return realPath;
		return `/${rel.split(nodePath.sep).join("/")}`;
	}

	// ------------------------------------------------------------------
	// Reads
	// ------------------------------------------------------------------

	async readFile(path: string): Promise<string> {
		return fs.readFile(this.toReal(path), "utf8");
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const buf = await fs.readFile(this.toReal(path));
		return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	}

	async exists(path: string): Promise<boolean> {
		try {
			await fs.access(this.toReal(path));
			return true;
		} catch {
			return false;
		}
	}

	async stat(path: string): Promise<UnionFileStat> {
		return toUnionStat(await fs.stat(this.toReal(path)));
	}

	async lstat(path: string): Promise<UnionFileStat> {
		return toUnionStat(await fs.lstat(this.toReal(path)));
	}

	async readdir(path: string): Promise<string[]> {
		return fs.readdir(this.toReal(path));
	}

	async readlink(path: string): Promise<string> {
		const target = await fs.readlink(this.toReal(path));
		// Absolute targets are stored on disk as real paths; map them back to
		// the virtual namespace so callers see the same paths they wrote.
		return nodePath.isAbsolute(target) ? this.toVirtual(target) : target;
	}

	async realpath(path: string): Promise<string> {
		return this.toVirtual(await fs.realpath(this.toReal(path)));
	}

	/**
	 * Synchronously enumerate every entry below the root as virtual paths.
	 * Symlinked directories are not traversed, which avoids infinite loops on
	 * the cyclic links the package store can create.
	 */
	getAllPaths(): string[] {
		const out: string[] = [];
		const walk = (realDir: string): void => {
			let entries: fsSync.Dirent[];
			try {
				entries = fsSync.readdirSync(realDir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const realChild = nodePath.join(realDir, entry.name);
				out.push(this.toVirtual(realChild));
				if (entry.isDirectory()) walk(realChild);
			}
		};
		walk(this.root);
		return out;
	}

	// ------------------------------------------------------------------
	// Writes
	// ------------------------------------------------------------------

	async writeFile(path: string, content: FileContent): Promise<void> {
		await fs.writeFile(this.toReal(path), content);
	}

	async mkdir(path: string, options?: InstallMkdirOptions): Promise<void> {
		await fs.mkdir(this.toReal(path), { recursive: options?.recursive });
	}

	async rm(path: string, options?: InstallRmOptions): Promise<void> {
		await fs.rm(this.toReal(path), {
			recursive: options?.recursive,
			force: options?.force,
		});
	}

	async symlink(target: string, linkPath: string): Promise<void> {
		// Preserve absolute (virtual) targets by translating them to real paths;
		// relative targets resolve the same way on a real fs, so pass through.
		const realTarget = isAbsolute(target) ? this.toReal(target) : target;
		await fs.symlink(realTarget, this.toReal(linkPath));
	}
}
