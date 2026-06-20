/**
 * Minimal filesystem interface used by the bundler module.
 *
 * This is a structural subset of just-bash's `IFileSystem`, containing only the
 * members the bundler actually relies on. Keeping it local lets the bundle
 * module be split out and reused without depending on just-bash. Any full
 * `IFileSystem` implementation remains assignable to this interface.
 *
 * The bundler only ever *reads* the filesystem — it resolves and loads modules
 * and hands the result back to the caller (esbuild runs with `write: false`).
 * So this surface is read-only; nothing here writes.
 */

/** Subset of stat information consumed by the bundler. */
export interface BundleFileStat {
	isFile: boolean;
}

/**
 * The (read-only) filesystem surface required by the bundler.
 */
export interface BundleFileSystem {
	/** Read the contents of a file as a string (utf8). */
	readFile(path: string): Promise<string>;
	/** Read the contents of a file as raw bytes. */
	readFileBuffer(path: string): Promise<Uint8Array>;
	/** Check if a path exists. */
	exists(path: string): Promise<boolean>;
	/** Get file/directory information. */
	stat(path: string): Promise<BundleFileStat>;
}
