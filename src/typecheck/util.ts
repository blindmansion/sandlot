/** Minimal context required by {@link findUp}. */
export interface FindUpContext {
	/** Directory to start searching from when `options.from` is omitted. */
	cwd: string;
	fs: {
		/** Check if a path exists. */
		exists(path: string): Promise<boolean>;
	};
}

export interface FindUpOptions {
	/** Directory to start searching from (default: `ctx.cwd`) */
	from?: string;
	/** Directory to stop searching at, inclusive (default: `"/"`) */
	stopAt?: string;
}

/**
 * Walk up from `ctx.cwd` (or `options.from`) toward the filesystem root,
 * checking each directory for a file matching one of the given `names`.
 *
 * Returns the absolute path of the first match, or `null` if nothing
 * is found before reaching `stopAt` (or root).
 *
 * @param ctx   The context (provides `fs` and `cwd`)
 * @param name  Filename (or array of filenames, tried in order) to look for
 */
export async function findUp(
	ctx: FindUpContext,
	name: string | readonly string[],
	options?: FindUpOptions,
): Promise<string | null> {
	const names = Array.isArray(name) ? name : [name];
	const from = options?.from ?? ctx.cwd;
	const stopAt = options?.stopAt ?? "/";

	let dir = from;

	while (true) {
		for (const n of names) {
			const filepath = join(dir, n);
			if (await ctx.fs.exists(filepath)) {
				return filepath;
			}
		}

		if (dir === stopAt) break;
		const parent = dirname(dir);
		if (parent === dir) break; // reached filesystem root
		dir = parent;
	}

	return null;
}

/** Normalize a path, resolving `.` and `..` segments and collapsing slashes */
export function normalize(path: string): string {
	if (path === "") return ".";
	if (path === "/") return "/";

	const isAbs = path.charCodeAt(0) === 47;
	const trailingSlash = path.charCodeAt(path.length - 1) === 47;

	const segments = path.split("/");
	const result: string[] = [];

	for (const seg of segments) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (isAbs) {
				result.pop(); // can't go above root
			} else if (result.length > 0 && result[result.length - 1] !== "..") {
				result.pop();
			} else {
				result.push("..");
			}
		} else {
			result.push(seg);
		}
	}

	let out = result.join("/");

	if (isAbs) {
		out = "/" + out;
	}

	if (trailingSlash && out.length > 1 && !out.endsWith("/")) {
		out += "/";
	}

	return out || (isAbs ? "/" : trailingSlash ? "./" : ".");
}

/** Join path segments and normalize the result */
export function join(...paths: string[]): string {
	if (paths.length === 0) return ".";
	const joined = paths.filter((p) => p !== "").join("/");
	if (joined === "") return ".";
	return normalize(joined);
}

/** Return the directory portion of a path */
export function dirname(path: string): string {
	if (path === "") return ".";
	if (path === "/") return "/";

	// Strip trailing slashes
	let end = path.length;
	while (end > 1 && path.charCodeAt(end - 1) === 47) end--;

	const trimmed = path.slice(0, end);
	const i = trimmed.lastIndexOf("/");

	if (i === -1) return ".";
	if (i === 0) return "/";
	return trimmed.slice(0, i);
}