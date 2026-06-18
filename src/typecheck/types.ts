/**
 * TypeScript type-checker types
 */

import type { VirtualTypeScriptEnvironment } from "@typescript/vfs";
import type ts from "typescript";
import type { TypecheckFileSystem } from "./fs";

// ============================================================================
// Factory deps & per-call args (public API)
// ============================================================================

/** Dependencies provided once at factory creation time */
export interface TypecheckDeps {
	/** Pre-loaded TypeScript lib files. If not provided, loaded from CDN on first call. */
	libMap?: Map<string, string>;
}

/** Per-call arguments passed to the typecheck function */
export interface TypecheckArgs {
	/** The filesystem containing source files */
	fs: TypecheckFileSystem;
	/** Root files to include in the program (defaults to all .ts/.tsx files) */
	rootFiles?: string[];
	/** Working directory (defaults to "/") */
	workingDirectory?: string;
	/**
	 * Lib mode:
	 * - "run": ES2020 only (no DOM types)
	 * - "render": ES2020 + DOM
	 * Defaults to "render".
	 */
	mode?: "run" | "render";
	/** Compiler options for TypeScript (typically parsed from tsconfig.json) */
	compilerOptions: ts.CompilerOptions;
}

/** Result of a typecheck run */
export interface TypecheckResult {
	/** Diagnostics keyed by file path (only files with diagnostics are included) */
	diagnostics: Map<string, Diagnostic[]>;
	/** The lib files that were used (can be passed as deps to avoid re-fetching) */
	libMap: Map<string, string>;
}

/** The typecheck function returned by the factory */
export type TypecheckFn = (args: TypecheckArgs) => Promise<TypecheckResult>;

// ============================================================================
// Diagnostic types
// ============================================================================

export interface Diagnostic {
	/** File path where the error occurred */
	file: string;
	/** Line number (1-indexed) */
	line: number;
	/** Column number (1-indexed) */
	column: number;
	/** Error message */
	message: string;
	/** Diagnostic category: "error" | "warning" | "suggestion" | "message" */
	category: "error" | "warning" | "suggestion" | "message";
	/** TypeScript error code (e.g., 2322) */
	code: number;
}

export type AllDiagnostics = Map<string, Diagnostic[]>;

// ============================================================================
// Internal types (used by environment.ts / services.ts, not exported from module)
// ============================================================================

export interface TypeCheckerEnvResult {
	/** The virtual TypeScript environment */
	env: VirtualTypeScriptEnvironment;
	/** The file map used by the environment */
	fsMap: Map<string, string>;
	/** Root files that were included */
	rootFiles: string[];
	/** TypeScript lib files */
	libMap: Map<string, string>;
}

/** Language service types (internal, for future editor integration) */

export interface CompletionItem {
	/** Name of the completion */
	name: string;
	/** Kind of completion (function, variable, class, etc.) */
	kind: string;
	/** Sort text for ordering */
	sortText: string;
	/** Whether this is a recommended completion */
	isRecommended?: boolean;
}

export interface QuickInfo {
	/** The kind of symbol (function, variable, etc.) */
	kind: string;
	/** Display text for the symbol */
	displayText: string;
	/** Documentation/JSDoc if available */
	documentation?: string;
}
