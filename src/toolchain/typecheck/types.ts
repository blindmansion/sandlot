/**
 * TypeScript type-checker types
 */

import type ts from "typescript";
import type { TypecheckFileSystem } from "./fs";

// ============================================================================
// Session API (public)
// ============================================================================

/** Options used to create a {@link TypecheckSession}. */
export interface TypecheckSessionOptions {
	/** The filesystem containing source files (the source of truth). */
	fs: TypecheckFileSystem;
	/**
	 * Compiler options for TypeScript. When {@link useProjectTsConfig} is set,
	 * these are layered *over* the project's parsed `tsconfig.json` (so they act
	 * as embedder-enforced overrides/fallbacks); otherwise they are used as-is.
	 */
	compilerOptions: ts.CompilerOptions;
	/**
	 * Lazily load the nearest `tsconfig.json` from `fs` (searching up from
	 * {@link workingDirectory}) at first check and merge its `compilerOptions` as
	 * the base, with {@link compilerOptions} layered on top. Loading is deferred
	 * to the first build so the file only needs to exist by the time the session
	 * actually checks (e.g. after a fixture is seeded). Defaults to `false`.
	 */
	useProjectTsConfig?: boolean;
	/**
	 * Lib mode:
	 * - "run": ES2020 only (no DOM types)
	 * - "render": ES2020 + DOM
	 * Defaults to "render".
	 */
	mode?: "run" | "render";
	/** Root files to include in the program (defaults to all project .ts/.tsx). */
	rootFiles?: string[];
	/**
	 * Extra ambient declaration files to inject into the program, keyed by
	 * virtual path (e.g. `"/__sandlot_globals__.d.ts"`). They live only inside
	 * the typecheck environment — never written to the caller's filesystem —
	 * and are always added as root files so their `declare` globals are visible
	 * to every source file.
	 *
	 * Use this to surface host-provided globals (such as the `.d.ts` produced by
	 * `generateHostFunctionDts`) to the typechecker.
	 */
	globalDeclarations?: Map<string, string>;
	/** Working directory (defaults to "/"). */
	workingDirectory?: string;
	/**
	 * Include suggestion diagnostics (the "weak warning" hints surfaced by the
	 * language service). These add an extra pass per file; set to `false` for a
	 * faster errors-only check. Defaults to `true`.
	 */
	includeSuggestions?: boolean;
	/** Pre-loaded lib files. If omitted, loaded from CDN (by mode) on first check. */
	libMap?: Map<string, string>;
}

/**
 * A single file mutation reported to a session. `content` is used for
 * `create`/`change`; if omitted the session reads the new content from its `fs`.
 */
export interface FileChange {
	type: "create" | "change" | "delete";
	path: string;
	content?: string;
}

/** Result of a typecheck run. */
export interface TypecheckResult {
	/** Diagnostics keyed by file path (only files with diagnostics are included). */
	diagnostics: Map<string, Diagnostic[]>;
	/** The lib files that were used (can be reused to avoid re-fetching). */
	libMap: Map<string, string>;
}

/**
 * A stateful, incremental type-checking session backed by a persistent
 * TypeScript program.
 *
 * The caller owns the filesystem; after mutating a file it tells the session
 * what changed (`changed`/`created`/`deleted`/`apply`) so only the affected
 * files are reparsed. `check()` then runs diagnostics against the in-memory
 * program, reusing cached `SourceFile`s for everything (libs + node_modules)
 * that did not change.
 *
 * Contract: notifications must mirror the filesystem — update the file, then
 * notify. After a dependency install/uninstall, call `invalidate()`.
 */
export interface TypecheckSession {
	/** Build the env lazily (first call / after invalidate), then run diagnostics. */
	check(): Promise<TypecheckResult>;
	/** Incrementally update an existing project file. */
	changed(path: string, content?: string): Promise<void>;
	/** Add a new project file as a root. */
	created(path: string, content?: string): Promise<void>;
	/** Remove a project file. */
	deleted(path: string): Promise<void>;
	/** Apply a batch of file changes. */
	apply(changes: FileChange[]): Promise<void>;
	/** Drop the cached env; the next `check()` rebuilds it from the filesystem. */
	invalidate(): void;
	/** Release the underlying program/language service. */
	dispose(): void;
}

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
// Internal types (used by services.ts, not exported from the module)
// ============================================================================

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
