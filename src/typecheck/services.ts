/**
 * TypeScript language services - diagnostics, completions, etc.
 */

import type { VirtualTypeScriptEnvironment } from "@typescript/vfs";
import ts from "typescript";
import type {
	AllDiagnostics,
	CompletionItem,
	Diagnostic,
	QuickInfo,
} from "./types";

/**
 * Get all diagnostics (type errors) for a file.
 */
export function getDiagnostics(
	env: VirtualTypeScriptEnvironment,
	fileName: string,
): Diagnostic[] {
	const syntactic = env.languageService.getSyntacticDiagnostics(fileName);
	const semantic = env.languageService.getSemanticDiagnostics(fileName);
	const suggestions = env.languageService.getSuggestionDiagnostics(fileName);

	const allDiagnostics = [...syntactic, ...semantic, ...suggestions];

	return allDiagnostics.map((d) => {
		let line = 1;
		let column = 1;

		if (d.file && d.start !== undefined) {
			const pos = d.file.getLineAndCharacterOfPosition(d.start);
			line = pos.line + 1;
			column = pos.character + 1;
		}

		const category = getCategoryString(d.category);
		const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");

		return {
			file: d.file?.fileName || fileName,
			line,
			column,
			message,
			category,
			code: d.code,
		};
	});
}

/**
 * Get all diagnostics for all root files in the environment.
 */
export function getAllDiagnostics(
	env: VirtualTypeScriptEnvironment,
	rootFiles: string[],
): Map<string, Diagnostic[]> {
	const results = new Map<string, Diagnostic[]>();

	for (const file of rootFiles) {
		const diagnostics = getDiagnostics(env, file);
		if (diagnostics.length > 0) {
			results.set(file, diagnostics);
		}
	}

	return results;
}

/**
 * Get completions at a position in a file.
 */
export function getCompletions(
	env: VirtualTypeScriptEnvironment,
	fileName: string,
	position: number,
): CompletionItem[] {
	const completions = env.languageService.getCompletionsAtPosition(
		fileName,
		position,
		{
			includeCompletionsForModuleExports: true,
			includeCompletionsWithInsertText: true,
		},
	);

	if (!completions) {
		return [];
	}

	return completions.entries.map((entry) => ({
		name: entry.name,
		kind: entry.kind,
		sortText: entry.sortText,
		isRecommended: entry.isRecommended,
	}));
}

/**
 * Get quick info (hover information) at a position.
 */
export function getQuickInfo(
	env: VirtualTypeScriptEnvironment,
	fileName: string,
	position: number,
): QuickInfo | undefined {
	const info = env.languageService.getQuickInfoAtPosition(fileName, position);

	if (!info) {
		return undefined;
	}

	const displayParts = info.displayParts || [];
	const displayText = displayParts.map((p) => p.text).join("");

	const documentationParts = info.documentation || [];
	const documentation = documentationParts.map((p) => p.text).join("");

	return {
		kind: info.kind,
		displayText,
		documentation: documentation || undefined,
	};
}

/**
 * Get definition locations for a symbol at a position.
 */
export function getDefinitions(
	env: VirtualTypeScriptEnvironment,
	fileName: string,
	position: number,
): Array<{ fileName: string; line: number; column: number }> {
	const definitions = env.languageService.getDefinitionAtPosition(
		fileName,
		position,
	);

	if (!definitions) {
		return [];
	}

	return definitions.map((def) => {
		const sourceFile = env.getSourceFile(def.fileName);
		let line = 1;
		let column = 1;

		if (sourceFile) {
			const pos = sourceFile.getLineAndCharacterOfPosition(def.textSpan.start);
			line = pos.line + 1;
			column = pos.character + 1;
		}

		return {
			fileName: def.fileName,
			line,
			column,
		};
	});
}

/**
 * Update a file in the environment (for incremental updates).
 *
 * @param env The TypeScript environment
 * @param fileName Path to the file
 * @param content New content (or partial content if using textSpan)
 * @param textSpan Optional span for partial updates - only replace this range.
 *                 If not provided, replaces the entire file content.
 */
export function updateFile(
	env: VirtualTypeScriptEnvironment,
	fileName: string,
	content: string,
	textSpan?: { start: number; length: number },
): void {
	const existingFile = env.getSourceFile(fileName);
	if (existingFile) {
		const span = textSpan
			? ts.createTextSpan(textSpan.start, textSpan.length)
			: undefined;
		env.updateFile(fileName, content, span);
	} else {
		env.createFile(fileName, content);
	}
}

/**
 * Create a new file in the environment.
 */
export function createFile(
	env: VirtualTypeScriptEnvironment,
	fileName: string,
	content: string,
): void {
	env.createFile(fileName, content);
}

/**
 * Delete a file from the environment.
 */
export function deleteFile(
	env: VirtualTypeScriptEnvironment,
	fileName: string,
): void {
	env.deleteFile(fileName);
}

/** Aggregate view of all diagnostics produced by a typecheck run. */
export interface DiagnosticSummary {
	/** Every diagnostic across all files, flattened into a single list. */
	all: Diagnostic[];
	/** Number of diagnostics with category "error". */
	errorCount: number;
	/** Number of diagnostics with category "warning". */
	warningCount: number;
}

/**
 * Flatten per-file diagnostics into a single list and count errors/warnings.
 */
export function summarizeDiagnostics(
	diagnostics: AllDiagnostics,
): DiagnosticSummary {
	const all: Diagnostic[] = [];
	for (const diags of diagnostics.values()) {
		all.push(...diags);
	}

	let errorCount = 0;
	let warningCount = 0;
	for (const d of all) {
		if (d.category === "error") errorCount++;
		else if (d.category === "warning") warningCount++;
	}

	return { all, errorCount, warningCount };
}

/**
 * Format diagnostics as a human-readable string.
 */
export function formatDiagnostics(diagnostics: Diagnostic[]): string {
	return diagnostics
		.map((d) => {
			const location = `${d.file}:${d.line}:${d.column}`;
			const prefix = d.category === "error" ? "error" : d.category;
			return `${location} - ${prefix} TS${d.code}: ${d.message}`;
		})
		.join("\n");
}

// ============================================================================
// Internal helpers
// ============================================================================

function getCategoryString(
	category: ts.DiagnosticCategory,
): "error" | "warning" | "suggestion" | "message" {
	switch (category) {
		case ts.DiagnosticCategory.Error:
			return "error";
		case ts.DiagnosticCategory.Warning:
			return "warning";
		case ts.DiagnosticCategory.Suggestion:
			return "suggestion";
		case ts.DiagnosticCategory.Message:
			return "message";
		default:
			return "error";
	}
}
