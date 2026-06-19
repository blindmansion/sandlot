/**
 * Minimal filesystem interface used by the install module.
 *
 * This is a structural subset of just-bash's `IFileSystem`, containing only the
 * members the installer actually relies on. Keeping it local lets the install
 * module be split out and reused without depending on just-bash. Any full
 * `IFileSystem` implementation remains assignable to this interface.
 */

/** File content that can be written to disk. */
export type FileContent = string | Uint8Array;

/** Subset of stat information consumed by the installer. */
export interface InstallFileStat {
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

/** Options accepted by {@link InstallFileSystem.mkdir}. */
export interface InstallMkdirOptions {
	recursive?: boolean;
}

/** Options accepted by {@link InstallFileSystem.rm}. */
export interface InstallRmOptions {
	recursive?: boolean;
	force?: boolean;
}

/**
 * The filesystem surface required by the installer.
 */
export interface InstallFileSystem {
	/** Read the contents of a file as a string (utf8). */
	readFile(path: string): Promise<string>;
	/** Write content to a file, creating it if it doesn't exist. */
	writeFile(path: string, content: FileContent): Promise<void>;
	/** Check if a path exists. */
	exists(path: string): Promise<boolean>;
	/** Get file/directory information, following symlinks. */
	stat(path: string): Promise<InstallFileStat>;
	/** Get file/directory information without following symlinks. */
	lstat(path: string): Promise<InstallFileStat>;
	/** Create a directory. */
	mkdir(path: string, options?: InstallMkdirOptions): Promise<void>;
	/** Remove a file or directory. */
	rm(path: string, options?: InstallRmOptions): Promise<void>;
	/** Read directory contents (entry names, not full paths). */
	readdir(path: string): Promise<string[]>;
	/** Read the target of a symbolic link. */
	readlink(path: string): Promise<string>;
	/** Create a symbolic link. */
	symlink(target: string, linkPath: string): Promise<void>;
}
