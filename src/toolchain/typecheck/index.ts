/**
 * TypeScript type-checking module
 *
 * Provides a persistent, incremental typecheck session that bridges the async
 * TypecheckFileSystem with TypeScript's synchronous virtual file system, keeping
 * one program alive so only changed files are reparsed between checks.
 */

// Session API
export { createTypecheckSession, runTypecheck } from "./session";
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
	FileChange,
	TypecheckResult,
	TypecheckSession,
	TypecheckSessionOptions,
} from "./types";
