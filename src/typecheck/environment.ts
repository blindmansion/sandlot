/**
 * TypeScript type-checker environment creation
 *
 * This module bridges the async TypecheckFileSystem with TypeScript's synchronous
 * Map-based virtual file system, enabling type-checking in the browser.
 */

import {
	createSystem,
	createVirtualTypeScriptEnvironment,
} from "@typescript/vfs";
import ts from "typescript";
import type { TypecheckFileSystem } from "./fs";
import type { TypeCheckerEnvResult, TypecheckArgs } from "./types";

// ============================================================================
// File extraction from TypecheckFileSystem
// ============================================================================

/**
 * Extract files from a TypecheckFileSystem into a Map<string, string> for @typescript/vfs.
 *
 * This walks the filesystem and extracts:
 * - Source files (.ts, .tsx, .js, .jsx)
 * - Type definition files (.d.ts)
 * - package.json files (for module resolution)
 *
 * For the global store, it follows symlinks and maps files to their expected locations
 * (e.g., files in `.store/zod/1.0.0/node_modules/zod/` are mapped to `/node_modules/zod/`).
 */
async function extractFilesToMap(
	fs: TypecheckFileSystem,
	options: {
		workingDirectory?: string;
		includeNodeModules?: boolean;
	} = {},
): Promise<Map<string, string>> {
	const fsMap = new Map<string, string>();
	const workingDir = options.workingDirectory || "/";
	const includeNodeModules = options.includeNodeModules ?? true;

	// Get all paths from the filesystem
	const allPaths = fs.getAllPaths();

	// Filter for relevant files
	const relevantExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"];
	const isRelevantFile = (path: string): boolean => {
		// Always include .d.ts files
		if (path.endsWith(".d.ts")) return true;

		// Include package.json for module resolution
		if (path.endsWith("package.json")) return true;

		// Include source files
		return relevantExtensions.some((ext) => path.endsWith(ext));
	};

	// Filter paths - exclude node_modules for now (we'll handle them separately)
	const sourceFiles = allPaths.filter((path) => {
		// Skip non-files (directories, etc.)
		if (path.endsWith("/")) return false;

		// Skip node_modules entirely - we'll add them with proper paths later
		if (path.includes("/node_modules/")) return false;

		return isRelevantFile(path);
	});

	// Read source files in parallel
	const readPromises = sourceFiles.map(async (path) => {
		try {
			const stat = await fs.stat(path);
			if (!stat.isFile) return null;

			const content = await fs.readFile(path);
			return { path, content };
		} catch {
			return null;
		}
	});

	const results = await Promise.all(readPromises);

	for (const result of results) {
		if (result) {
			fsMap.set(result.path, result.content);
		}
	}

	// Handle node_modules with proper symlink resolution
	if (includeNodeModules) {
		const nodeModulesPath = `${workingDir.endsWith("/") ? workingDir : `${workingDir}/`}node_modules`;
		await extractNodeModulesWithSymlinks(fs, fsMap, nodeModulesPath);
	}

	return fsMap;
}

/**
 * Extract node_modules files, following symlinks to map files to expected locations.
 * This handles the global store where packages are in .store/ but symlinked from top-level.
 */
async function extractNodeModulesWithSymlinks(
	fs: TypecheckFileSystem,
	fsMap: Map<string, string>,
	nodeModulesPath: string,
): Promise<void> {
	if (!(await fs.exists(nodeModulesPath))) {
		return;
	}

	try {
		const entries = await fs.readdir(nodeModulesPath);

		for (const entry of entries) {
			// Skip the .store directory - we'll access it through symlinks
			if (entry === ".store") continue;

			const entryPath = `${nodeModulesPath}/${entry}`;

			// Handle scoped packages (@scope/package)
			if (entry.startsWith("@")) {
				try {
					const scopedPackages = await fs.readdir(entryPath);
					for (const scopedPkg of scopedPackages) {
						const scopedPkgPath = `${entryPath}/${scopedPkg}`;
						const pkgName = `${entry}/${scopedPkg}`;
						await extractPackageFiles(
							fs,
							fsMap,
							scopedPkgPath,
							`${nodeModulesPath}/${pkgName}`,
						);
					}
				} catch {
					// Ignore errors
				}
				continue;
			}

			// Regular package - extract its files
			await extractPackageFiles(fs, fsMap, entryPath, entryPath);
		}
	} catch {
		// node_modules might not exist
	}
}

/**
 * Extract files from a package directory (following symlinks if needed).
 * Files are added to the map with the targetPath prefix.
 */
async function extractPackageFiles(
	fs: TypecheckFileSystem,
	fsMap: Map<string, string>,
	sourcePath: string,
	targetPath: string,
	subPath: string = "",
): Promise<void> {
	const currentSourcePath = subPath ? `${sourcePath}/${subPath}` : sourcePath;
	const currentTargetPath = subPath ? `${targetPath}/${subPath}` : targetPath;

	try {
		// Check if it's a symlink and resolve it
		const stat = await fs.lstat(currentSourcePath);

		if (stat.isSymbolicLink && !subPath) {
			// For top-level symlinks, resolve and recurse with the target path
			const realPath = await fs.realpath(currentSourcePath);
			await extractPackageFilesFromRealPath(fs, fsMap, realPath, targetPath);
			return;
		}

		if (stat.isFile) {
			// Only extract relevant files
			if (isTypeScriptRelevantFile(currentSourcePath)) {
				const content = await fs.readFile(currentSourcePath);
				fsMap.set(currentTargetPath, content);
			}
			return;
		}

		if (stat.isDirectory) {
			const entries = await fs.readdir(currentSourcePath);

			for (const entry of entries) {
				// Skip nested node_modules
				if (entry === "node_modules") continue;

				const newSubPath = subPath ? `${subPath}/${entry}` : entry;
				await extractPackageFiles(
					fs,
					fsMap,
					sourcePath,
					targetPath,
					newSubPath,
				);
			}
		}
	} catch {
		// Entry might not exist or be unreadable
	}
}

/**
 * Extract files from a resolved real path, mapping to the target path.
 */
async function extractPackageFilesFromRealPath(
	fs: TypecheckFileSystem,
	fsMap: Map<string, string>,
	realPath: string,
	targetPath: string,
	subPath: string = "",
): Promise<void> {
	const currentRealPath = subPath ? `${realPath}/${subPath}` : realPath;
	const currentTargetPath = subPath ? `${targetPath}/${subPath}` : targetPath;

	try {
		const stat = await fs.stat(currentRealPath);

		if (stat.isFile) {
			if (isTypeScriptRelevantFile(currentRealPath)) {
				const content = await fs.readFile(currentRealPath);
				fsMap.set(currentTargetPath, content);
			}
			return;
		}

		if (stat.isDirectory) {
			const entries = await fs.readdir(currentRealPath);

			for (const entry of entries) {
				// Skip nested node_modules
				if (entry === "node_modules") continue;

				const newSubPath = subPath ? `${subPath}/${entry}` : entry;
				await extractPackageFilesFromRealPath(
					fs,
					fsMap,
					realPath,
					targetPath,
					newSubPath,
				);
			}
		}
	} catch {
		// Entry might not exist
	}
}

/**
 * Check if a file is relevant for TypeScript type-checking.
 */
function isTypeScriptRelevantFile(path: string): boolean {
	// Type definitions
	if (path.endsWith(".d.ts")) return true;

	// Package manifest
	if (path.endsWith("package.json")) return true;

	// Source files (for cases where packages have .ts source)
	const ext = path.substring(path.lastIndexOf("."));
	return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"].includes(ext);
}

/**
 * Find all root files (source files in the project, not in node_modules)
 *
 * @param fsMap - The file map containing all files
 * @param workingDir - The working directory (project root with tsconfig/package.json)
 */
function findRootFiles(
	fsMap: Map<string, string>,
	workingDir: string,
): string[] {
	const rootFiles: string[] = [];

	// Normalize working directory to ensure consistent comparison
	const normalizedWorkingDir = workingDir.endsWith("/")
		? workingDir
		: `${workingDir}/`;

	for (const path of fsMap.keys()) {
		// Only include files within the working directory
		if (!path.startsWith(normalizedWorkingDir) && path !== workingDir) continue;

		// Skip node_modules
		if (path.includes("/node_modules/")) continue;

		// Include TypeScript source files and ambient declaration files.
		// In a real tsconfig the default `include` pattern picks up both;
		// we replicate that here for the virtual FS.
		if (path.endsWith(".ts") || path.endsWith(".tsx")) {
			rootFiles.push(path);
		}
	}

	return rootFiles;
}

// ============================================================================
// Main API
// ============================================================================

/**
 * Derive the `lib` compiler option from the lib files we actually loaded.
 *
 * There are three representations of lib names:
 * - tsconfig.json (human):      `"ES2020"`, `"DOM"`
 * - ts.CompilerOptions.lib:     `"lib.es2020.d.ts"`, `"lib.dom.d.ts"`
 * - @typescript/vfs libMap keys: `"/lib.es2020.d.ts"`, `"/lib.dom.d.ts"`
 *
 * We need the middle format. Since our libMap keys use the vfs convention
 * (leading slash), we strip it.
 */
function deriveLibFromLoadedFiles(libMap: Map<string, string>): string[] {
	const libs: string[] = [];
	for (const key of libMap.keys()) {
		// Keys are like "/lib.es2020.d.ts" -> "lib.es2020.d.ts"
		if (key.startsWith("/lib.") && key.endsWith(".d.ts")) {
			libs.push(key.slice(1));
		}
	}
	return libs;
}

/**
 * Build a `directory -> immediate child directory names` index from the file
 * map keys. Keys are normalized without a trailing slash (except root "/").
 *
 * For a path like `/node_modules/@types/lodash/common/array.d.ts` this records:
 *   "/" -> "node_modules", "/node_modules" -> "@types",
 *   "/node_modules/@types" -> "lodash", ".../lodash" -> "common".
 * The final segment (the file itself) is never recorded as a directory.
 */
function buildDirectoryIndex(
	fsMap: Map<string, string>,
): Map<string, Set<string>> {
	const index = new Map<string, Set<string>>();
	const add = (dir: string, child: string): void => {
		let set = index.get(dir);
		if (!set) {
			set = new Set<string>();
			index.set(dir, set);
		}
		set.add(child);
	};

	for (const path of fsMap.keys()) {
		const parts = path.split("/");
		// parts[0] is "" for absolute paths; the last entry is the file name.
		let dir = "";
		for (let i = 1; i < parts.length - 1; i++) {
			const child = parts[i];
			if (!child) continue;
			add(dir === "" ? "/" : dir, child);
			dir = `${dir}/${child}`;
		}
	}

	return index;
}

/**
 * Create a TypeScript type-checker environment from a TypecheckFileSystem.
 *
 * This extracts files from the filesystem and creates a virtual TypeScript
 * environment for type-checking. The caller is responsible for adding any
 * custom declaration files (e.g., sandbox-env.d.ts) to the filesystem
 * before calling this function.
 *
 * Compiler options come from the caller (typically parsed from tsconfig.json),
 * but `lib` and `skipDefaultLibCheck` are always overridden to match the lib
 * files that were actually loaded into the virtual FS.
 *
 * @param fs - The filesystem containing source files
 * @param libMap - TypeScript lib files (lib.es2020.d.ts, lib.dom.d.ts, etc.)
 * @param args - Per-call arguments (working directory, compiler options, etc.)
 */
export async function createTypeCheckerEnv(
	fs: TypecheckFileSystem,
	libMap: Map<string, string>,
	args: TypecheckArgs,
): Promise<TypeCheckerEnvResult> {
	const workingDir = args.workingDirectory || "/";

	// Merge caller's compiler options with environment-controlled overrides.
	// `lib` must match the files we loaded, not what tsconfig says, because
	// in our virtual FS only the loaded libs exist.
	const compilerOptions: ts.CompilerOptions = {
		...args.compilerOptions,
		lib: deriveLibFromLoadedFiles(libMap),
		skipDefaultLibCheck: true,
		// Default to skipping semantic checks of dependency `.d.ts` files — the
		// dominant cost when a small project depends on large libraries. Callers
		// can opt back in by setting `skipLibCheck: false` in their tsconfig.
		skipLibCheck: args.compilerOptions.skipLibCheck ?? true,
	};

	// Step 1: Extract files from the filesystem
	const fsMap = await extractFilesToMap(fs, {
		workingDirectory: workingDir,
		includeNodeModules: true,
	});

	// Step 2: Merge lib files into fsMap
	for (const [path, content] of libMap) {
		fsMap.set(path, content);
	}

	// Step 3: Determine root files
	const rootFiles = args.rootFiles || findRootFiles(fsMap, workingDir);

	// Step 4: Create the TypeScript virtual environment
	const system = createSystem(fsMap);

	// @typescript/vfs's createSystem stubs getDirectories to return [],
	// which breaks TypeScript's module resolution for @types subpath
	// exports (e.g. react-dom/client → @types/react-dom/client.d.ts).
	// Derive real directory listings from the fsMap keys.
	//
	// Module resolution calls getDirectories many times, so instead of scanning
	// every fsMap key per query (O(files) each call), build a directory → child
	// directories index once up front and serve lookups from it.
	const directoryIndex = buildDirectoryIndex(fsMap);
	system.getDirectories = (directory: string): string[] => {
		const key =
			directory.length > 1 && directory.endsWith("/")
				? directory.slice(0, -1)
				: directory;
		const children = directoryIndex.get(key === "" ? "/" : key);
		return children ? [...children] : [];
	};

	const env = createVirtualTypeScriptEnvironment(
		system,
		rootFiles,
		ts,
		compilerOptions,
	);

	return { env, fsMap, rootFiles, libMap };
}
