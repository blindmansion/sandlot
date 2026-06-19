/**
 * CLI formatting layer for run results.
 *
 * The core run layer (`src/run`) is presentation-agnostic: it produces a
 * {@link RunCodeResult} with an ordered log and a success flag. This module
 * is where CLI-shaped concerns live — splitting the log into stdout/stderr
 * streams, appending an uncaught error to stderr, and mapping success to a
 * process exit code. Nothing in core depends on this; it's opt-in for callers
 * that actually want a terminal-style representation.
 */

import type { LogLevel, RunCodeResult } from "../toolchain/run/types";

const STDOUT_LEVELS: LogLevel[] = ["log", "info", "debug"];
const STDERR_LEVELS: LogLevel[] = ["warn", "error"];

/** A terminal-style view of a run: stream text plus an exit code. */
export interface CliOutput {
	/** Captured stdout (console.log, console.info, console.debug). */
	stdout: string;
	/** Captured stderr (console.warn, console.error, and any uncaught error). */
	stderr: string;
	/** Process-style exit code: 0 on success, 1 on failure. */
	exitCode: number;
}

/** Ensure non-empty text ends with exactly one trailing newline. */
export function withTrailingNewline(text: string): string {
	if (text.length === 0 || text.endsWith("\n")) {
		return text;
	}
	return `${text}\n`;
}

/** Join lines with newlines and guarantee a trailing newline. */
export function joinOutputLines(lines: string[]): string {
	return withTrailingNewline(lines.join("\n"));
}

/**
 * Render a {@link RunCodeResult} into CLI streams and an exit code.
 *
 * stdout collects log/info/debug entries; stderr collects warn/error entries
 * followed by the uncaught error message (if any). The exit code is 0 when the
 * run succeeded and 1 otherwise.
 */
export function formatCli(result: RunCodeResult): CliOutput {
	const stdout = joinOutputLines(
		result.log
			.filter((e) => STDOUT_LEVELS.includes(e.level))
			.map((e) => e.text),
	);

	const stderrLines = result.log
		.filter((e) => STDERR_LEVELS.includes(e.level))
		.map((e) => e.text);
	if (result.error) {
		stderrLines.push(result.error.message);
	}
	const stderr = joinOutputLines(stderrLines);

	return { stdout, stderr, exitCode: result.ok ? 0 : 1 };
}
