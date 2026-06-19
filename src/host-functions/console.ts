/**
 * Factory for console.* host functions.
 *
 * Creates fire-and-forget host functions for console.log, console.info,
 * console.debug, console.warn, and console.error. Each call formats its
 * arguments and invokes the provided callback with the log level and text.
 */

import type { HostFunction, LogLevel } from "../run/types";
import { defineHostFunction } from "../run/types";

const CONSOLE_METHODS: LogLevel[] = ["log", "info", "debug", "warn", "error"];

function formatArgs(...args: unknown[]): string {
	return args
		.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
		.join(" ");
}

/**
 * Create the `console.*` host functions backed by a callback.
 *
 * The callback receives the log level and formatted text for each call.
 * All functions use `fireAndForget: true` so the guest doesn't wait
 * for a response — matching the fire-and-forget semantics of console.
 *
 * @example
 * ```ts
 * const log: LogEntry[] = [];
 * const consoleFns = createConsoleHostFunctions((level, text) => {
 *   log.push({ level, text });
 * });
 * ```
 */
export function createConsoleHostFunctions(
	callback: (level: LogLevel, text: string) => void,
): HostFunction[] {
	return CONSOLE_METHODS.map((level) =>
		defineHostFunction({
			path: ["console", level],
			fn: (...args: unknown[]) => {
				callback(level, formatArgs(...args));
			},
			dts: "(...args: unknown[]) => void",
			fireAndForget: true,
		}),
	);
}
