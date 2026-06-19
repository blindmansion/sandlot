/**
 * Minimal filesystem interface used by the typecheck module.
 *
 * This is a structural subset of just-bash's `IFileSystem`, containing only the
 * members the type-checker actually relies on. Keeping it local lets the
 * typecheck module be split out and reused without depending on just-bash. Any
 * full `IFileSystem` implementation remains assignable to this interface.
 */

/** Subset of stat information consumed by the type-checker. */
export interface TypecheckFileStat {
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

/**
 * The filesystem surface required by the type-checker.
 */
export interface TypecheckFileSystem {
	/** Read the contents of a file as a string (utf8). */
	readFile(path: string): Promise<string>;
	/** Check if a path exists. */
	exists(path: string): Promise<boolean>;
	/** Get file/directory information, following symlinks. */
	stat(path: string): Promise<TypecheckFileStat>;
	/** Get file/directory information without following symlinks. */
	lstat(path: string): Promise<TypecheckFileStat>;
	/** Read directory contents (entry names, not full paths). */
	readdir(path: string): Promise<string[]>;
	/** Resolve all symlinks in a path to its canonical physical path. */
	realpath(path: string): Promise<string>;
	/** Get all paths in the filesystem (used to enumerate source files). */
	getAllPaths(): string[];
}
