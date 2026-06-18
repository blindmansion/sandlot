/**
 * TypeScript type-checking module
 *
 * Provides a factory-based typecheck pipeline that bridges the async TypecheckFileSystem
 * with TypeScript's synchronous virtual file system for type-checking in the browser.
 */

// Factory
export { createTypecheckFn } from "./create";
// Filesystem interface
export type { TypecheckFileStat, TypecheckFileSystem } from "./fs";
// Lib loading (for consumers who want to pre-load and share lib files)
export { loadLibFilesFromCDN, RENDER_LIBS, RUN_LIBS } from "./lib-loader";
// Utilities
export {
	type DiagnosticSummary,
	formatDiagnostics,
	summarizeDiagnostics,
} from "./services";
// tsconfig.json resolution
export {
	type LoadedTsConfig,
	type LoadTsConfigContext,
	loadTsConfig,
} from "./tsconfig";
// Types
export type {
	AllDiagnostics,
	Diagnostic,
	TypecheckArgs,
	TypecheckDeps,
	TypecheckFn,
	TypecheckResult,
} from "./types";
