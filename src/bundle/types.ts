/**
 * Shared types for the bundler module
 *
 * These types are used by both native esbuild and esbuild-wasm implementations.
 */

import type * as esbuild from "esbuild-wasm";
import type { BuiltinCategory } from "./builtins";
import type { BundleFileSystem } from "./fs";

export type BundleResolutionPreset =
	| "executable-browser"
	| "executable-node"
	| "library";

export type MissingBareImportBehavior = "error" | "external";

export type NodeBuiltinBehavior = "error" | "external";

export interface ResolutionPolicy {
	/**
	 * Named resolution preset that establishes sensible defaults for the target
	 * runtime. Operators can override individual fields without redefining the
	 * entire behavior matrix.
	 */
	preset?: BundleResolutionPreset;
	/** What to do when a bare package import cannot be resolved from node_modules. */
	missingBareImports?: MissingBareImportBehavior;
	/** How to treat Node.js builtin modules like `fs` or `crypto`. */
	nodeBuiltins?: NodeBuiltinBehavior;
	/**
	 * Bare specifiers or package names that should remain external even when the
	 * active preset would otherwise require full resolution.
	 */
	allowedExternals?: string[];
}

export interface ResolvedResolutionPolicy {
	preset: BundleResolutionPreset;
	missingBareImports: MissingBareImportBehavior;
	nodeBuiltins: NodeBuiltinBehavior;
	allowedExternals: string[];
}

export interface BundleArgs {
	fs: BundleFileSystem;
	entryPoint: string;
	/** Directory used to resolve a relative entry point like `src/index.ts`. */
	entryResolveDir: string;
	/**
	 * Fallback directory used to resolve bare package imports before an importer
	 * path is available. Defaults to `entryResolveDir` when omitted.
	 */
	packageResolveDir?: string;
	/** In-memory files that should be visible to the bundler without being written to `fs`. */
	virtualFiles?: VirtualFileMap;
	options?: BundleOptions;
}

export type VirtualFileContents = string | Uint8Array;

export interface VirtualFile {
	contents: VirtualFileContents;
	/** Loader used by esbuild. Defaults to inferring from the virtual file path. */
	loader?: esbuild.Loader;
	/** Directory used to resolve relative imports from this virtual file. */
	resolveDir?: string;
}

export type VirtualFileMap = Record<string, VirtualFile>;

export const DEFAULT_RESOLUTION_POLICY: ResolvedResolutionPolicy = {
	preset: "executable-browser",
	missingBareImports: "error",
	nodeBuiltins: "error",
	allowedExternals: [],
};

export const DEFAULT_BUNDLE_OPTIONS: ResolvedBundleOptions = {
	format: "esm",
	platform: "browser",
	minify: false,
	sourcemap: "inline",
	target: "esnext",
	external: [],
	define: {},
	inject: [],
	alias: {},
	resolution: DEFAULT_RESOLUTION_POLICY,
};

export interface BundleOptions {
	/** Output format: "esm" | "cjs" | "iife" */
	format?: "esm" | "cjs" | "iife";
	/** Platform: "browser" | "node" | "neutral" */
	platform?: "browser" | "node" | "neutral";
	/** Minify the output */
	minify?: boolean;
	/** Generate source maps */
	sourcemap?: boolean | "linked" | "inline" | "external" | "both" | undefined;
	/** Target environment (e.g., "es2020", "node16") */
	target?: string;
	/** External packages (don't bundle these) */
	external?: string[];
	/** Define global constants */
	define?: Record<string, string>;
	/** Inject scripts into the bundle */
	inject?: string[];
	/** Alias packages */
	alias?: Record<string, string>;
	/** Resolution behavior for bare imports and Node.js builtins. */
	resolution?: ResolutionPolicy;
	/** Output file path — required for external/linked/both sourcemaps */
	outfile?: string;
}

export interface ResolvedBundleOptions {
	format: "esm" | "cjs" | "iife";
	platform: "browser" | "node" | "neutral";
	minify: boolean;
	sourcemap: boolean | "linked" | "inline" | "external" | "both" | undefined;
	target: string;
	external: string[];
	define: Record<string, string>;
	inject: string[];
	alias: Record<string, string>;
	resolution: ResolvedResolutionPolicy;
	/** Output file path — required for external/linked/both sourcemaps */
	outfile?: string;
}

export interface BundleResult {
	/** The bundled JavaScript code */
	code: string;
	/** The bundled CSS (if any CSS was imported) */
	css?: string;
	/** Source map for JS (if requested) */
	map?: string;
	/** Source map for CSS (if requested and CSS exists) */
	cssMap?: string;
	/** Warnings from esbuild */
	warnings: esbuild.Message[];
	/** Files that were included in the bundle */
	inputs: string[];
	/** Node.js built-in modules required by this bundle */
	nativeDependencies: NativeDependencySummary;
}

/**
 * The esbuild API interface that both native and wasm implementations provide.
 * This allows us to write code that works with either version.
 */
export interface EsbuildAPI {
	build(options: esbuild.BuildOptions): Promise<esbuild.BuildResult>;
}

export type BundleFn = (args: BundleArgs) => Promise<BundleResult>;

/**
 * Information about a Node.js built-in module used by the bundle
 */
export interface NativeDependency {
	/** The module name (e.g., "fs", "crypto", "path") */
	module: string;
	/** Category of the built-in (filesystem, network, crypto, etc.) */
	category: BuiltinCategory;
	/** Files that import this module (full paths) */
	importedBy: string[];
	/** Package names that use this module (extracted from paths) */
	packages: string[];
}

/**
 * Summary of native dependencies for easy consumption
 */
export interface NativeDependencySummary {
	/** Total count of unique native modules used */
	count: number;
	/** List of all native modules used */
	modules: string[];
	/** Modules grouped by category */
	byCategory: Partial<Record<BuiltinCategory, string[]>>;
	/** Detailed information for each module */
	details: NativeDependency[];
}
