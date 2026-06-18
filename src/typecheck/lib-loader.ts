/**
 * TypeScript Lib File Loader
 *
 * Fetches TypeScript lib files (lib.es2020.d.ts, lib.dom.d.ts, etc.) from CDN
 * and follows `/// <reference lib="..." />` directives to load all dependencies.
 */

/**
 * TypeScript version to use for lib files.
 * Pinned to a stable version that we know works.
 */
export const TS_LIB_VERSION = "5.7.3";

/** CDN base URL for TypeScript lib files */
export const TS_LIB_CDN_BASE = `https://cdn.jsdelivr.net/npm/typescript@${TS_LIB_VERSION}/lib`;

/** Default libs for render mode (full DOM) */
export const RENDER_LIBS = ["es2020", "dom", "dom.iterable"];

/** Default libs for run mode (ES only, no DOM) */
export const RUN_LIBS = ["es2020"];

/** Default libs to load - these reference other libs which are loaded transitively */
export const DEFAULT_LIBS = RENDER_LIBS;

/**
 * Parse `/// <reference lib="..." />` directives from a lib file.
 */
export function parseLibReferences(content: string): string[] {
	const refs: string[] = [];
	const regex = /\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/>/g;

	for (const match of content.matchAll(regex)) {
		if (match[1]) {
			refs.push(match[1]);
		}
	}

	return refs;
}

/**
 * Convert a lib name to its filename.
 * e.g., "es2020" -> "lib.es2020.d.ts"
 */
export function libNameToFileName(name: string): string {
	return `lib.${name}.d.ts`;
}

/**
 * Fetch a single lib file from CDN.
 */
export async function fetchLibFile(name: string): Promise<string> {
	const fileName = libNameToFileName(name);
	const url = `${TS_LIB_CDN_BASE}/${fileName}`;

	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`Failed to fetch ${url}: ${response.status} ${response.statusText}`,
		);
	}

	return response.text();
}

/**
 * Load TypeScript lib files from CDN.
 * Follows `/// <reference lib="..." />` directives to fetch all dependencies.
 * Returns a Map of lib name -> content.
 *
 * @param libs - Array of lib names to load (defaults to DEFAULT_LIBS)
 */
export async function loadLibFilesFromCDN(
	libs: string[] = DEFAULT_LIBS,
): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	const pending = new Set<string>(libs);
	const fetched = new Set<string>();

	while (pending.size > 0) {
		const batch = Array.from(pending);
		pending.clear();

		const results = await Promise.all(
			batch.map(async (name) => {
				if (fetched.has(name)) {
					return { name, content: null };
				}
				fetched.add(name);

				try {
					const content = await fetchLibFile(name);
					return { name, content };
				} catch {
					return { name, content: null };
				}
			}),
		);

		for (const { name, content } of results) {
			if (content === null) continue;

			// Use leading slash to match @typescript/vfs expectations
			result.set(`/${libNameToFileName(name)}`, content);

			// Parse references and queue unfetched ones
			const refs = parseLibReferences(content);
			for (const ref of refs) {
				if (!fetched.has(ref) && !pending.has(ref)) {
					pending.add(ref);
				}
			}
		}
	}

	return result;
}
