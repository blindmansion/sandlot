/**
 * Minimal filesystem interface used by the bundler module.
 *
 * This is a structural subset of just-bash's `IFileSystem`, containing only the
 * members the bundler actually relies on. Keeping it local lets the bundle
 * module be split out and reused without depending on just-bash. Any full
 * `IFileSystem` implementation remains assignable to this interface.
 */

/** File content that can be written to disk. */
export type FileContent = string | Uint8Array;

/** Subset of stat information consumed by the bundler. */
export interface BundleFileStat {
	isFile: boolean;
}

/** Options accepted by {@link BundleFileSystem.mkdir}. */
export interface BundleMkdirOptions {
	recursive?: boolean;
}

/**
 * The filesystem surface required by the bundler.
 */
export interface BundleFileSystem {
	/** Read the contents of a file as a string (utf8). */
	readFile(path: string): Promise<string>;
	/** Read the contents of a file as raw bytes. */
	readFileBuffer(path: string): Promise<Uint8Array>;
	/** Write content to a file, creating it if it doesn't exist. */
	writeFile(path: string, content: FileContent): Promise<void>;
	/** Check if a path exists. */
	exists(path: string): Promise<boolean>;
	/** Get file/directory information. */
	stat(path: string): Promise<BundleFileStat>;
	/** Create a directory. */
	mkdir(path: string, options?: BundleMkdirOptions): Promise<void>;
}
