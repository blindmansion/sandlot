/**
 * Shared types for the runner module.
 *
 * A RunFn executes bundled JavaScript code and returns captured output.
 * Implementations can run code in the main thread (Function()), a web
 * worker, a remote server, etc.
 */

import type { Transferable } from "bun";

/**
 * A callable provided by the host environment and injected into the
 * guest execution context.
 *
 * The `path` determines where the function appears in the global scope:
 *
 * - `["fetch"]`              → top-level `fetch(…)`
 * - `["Sand", "fs", "readFile"]` → `Sand.fs.readFile(…)`
 *
 * The runner assembles nested namespace objects automatically.
 * Every leaf in the tree is a function — each one is independently
 * bridgeable across isolation boundaries (worker, iframe, remote).
 */
export interface HostFunction {
	/**
	 * The path to the function in the global scope.
	 * Single-element paths create top-level globals; multi-element paths
	 * create nested namespace objects.
	 */
	path: string[];
	/** The implementation to call when the guest code invokes this function. May be sync or async. */
	fn: (...args: unknown[]) => unknown | Promise<unknown>;
	/**
	 * TypeScript type signature for this function (callable signature only).
	 * Used to generate ambient declarations for the typechecker.
	 *
	 * @example "(path: string) => string"
	 * @example "(path: string, data: string) => void"
	 */
	dts: string;

	/**
	 * Optional human-readable documentation for this function. When the ambient
	 * declarations are generated (see `generateHostFunctionDts`), this becomes a
	 * JSDoc comment above the function — useful when the `.d.ts` is surfaced in
	 * an editor or written to a real filesystem. Multi-line strings are
	 * supported; each line becomes a line of the JSDoc block.
	 *
	 * @example "Read a file's contents as UTF-8 text."
	 */
	doc?: string;

	// --- Host-side hooks (cross-boundary runners only) ---
	//
	// These hooks run on the **host** (main thread) during cross-boundary
	// execution (e.g. worker runner). They are NOT called by the native
	// runner, which passes `fn` results directly to the guest.
	//
	// The call sequence in the host handler is:
	//   1. Receive args from guest via postMessage (structured clone)
	//   2. `deserializeArgs(args)` → transform args if needed
	//   3. `fn(...args)` → call the host function
	//   4. `serializeReturn(result)` → transform result for the wire
	//   5. `getTransferables(serialized)` → extract zero-copy transferables
	//   6. Send serialized result back to guest via postMessage
	//
	// All hooks may be sync or async (the host handler awaits them).

	/**
	 * Transform args received from the guest before calling `fn()`.
	 *
	 * **Runs on:** host, after structured-clone deserialization of guest args.
	 * **Called with:** the args array as received from postMessage.
	 * **Returns:** the args array to pass to `fn()`.
	 *
	 * May be sync or async. Default: use args as-is.
	 */
	deserializeArgs?: (args: unknown[]) => unknown[] | Promise<unknown[]>;

	/**
	 * Transform the return value of `fn()` before sending it back to the guest.
	 *
	 * **Runs on:** host, after `fn()` resolves.
	 * **Called with:** the resolved return value of `fn()`.
	 * **Returns:** a structured-cloneable value to send via postMessage.
	 *
	 * May be sync or async. Default: send result as-is.
	 *
	 * @example For a real fetch: `async (r) => ({ status: r.status, body: await r.text(), headers: Object.fromEntries(r.headers) })`
	 */
	serializeReturn?: (result: unknown) => unknown | Promise<unknown>;

	/**
	 * Extract Transferable objects from the serialized return value
	 * for zero-copy transfer via postMessage (e.g. ArrayBuffers).
	 *
	 * **Runs on:** host, after `serializeReturn()` resolves.
	 * **Called with:** the serialized (wire-safe) return value.
	 * **Returns:** array of Transferable objects to transfer (not clone).
	 */
	getTransferables?: (result: unknown) => Transferable[];

	// --- Fire-and-forget ---

	/**
	 * When true, the guest sends the call and moves on without waiting
	 * for a response. The host still executes `fn()`, but doesn't send
	 * back a `host-response` message.
	 *
	 * In worker mode the guest stub is synchronous (plain `postMessage`,
	 * no pending promise). In native mode there is no difference — the
	 * function is called directly either way.
	 *
	 * Use for void side-effect functions where the guest doesn't need
	 * a return value: logging, analytics, telemetry, etc.
	 *
	 * @default false
	 */
	fireAndForget?: boolean;

	// --- Guest-side reconstruction ---

	/**
	 * A JavaScript code string for a function expression that transforms
	 * the raw return value on the **guest** side after it arrives via
	 * postMessage.
	 *
	 * **Runs on:** guest (worker), after the host response is received.
	 * **Called with:** the raw result from postMessage (output of
	 *   `serializeReturn`, or `fn()` directly if no serializer is set).
	 * **Returns:** the value the guest code actually receives.
	 *
	 * Use this when `fn()` returns a wire-safe plain object and the guest
	 * needs something richer — e.g. reconstructing a `Response` from
	 * `{ status, body, headers }`.
	 *
	 * The string must be a valid function expression: `(raw) => ...` or
	 * `function(raw) { ... }`. It is injected into the generated guest
	 * preamble and called on the result before returning to the guest code.
	 *
	 * Only used by cross-boundary runners. The native runner returns
	 * `fn()` results directly (no guest-side transformation).
	 *
	 * @example "(r) => new Response(r.body, { status: r.status, headers: r.headers })"
	 */
	guestDeserialize?: string;
}

/**
 * Define a host function with full type safety across `fn` and its hooks.
 *
 * TypeScript infers `TArgs` and `TReturn` from `fn`, then enforces:
 * - `deserializeArgs` must return `TArgs` (matching `fn`'s parameters)
 * - `serializeReturn` receives `Awaited<TReturn>` (the resolved return value)
 *
 * The returned object is a plain {@link HostFunction} (generics erased)
 * suitable for storage in arrays.
 *
 * @example
 * ```ts
 * defineHostFunction({
 *   path: ["Sand", "fs", "readFile"],
 *   fn: (path: string) => readFileSync(path),
 *   dts: "(path: string) => string",
 * })
 * ```
 */
export function defineHostFunction<TArgs extends unknown[], TReturn>(config: {
	path: string[];
	fn: (...args: TArgs) => TReturn;
	dts: string;
	doc?: string;
	deserializeArgs?: (args: unknown[]) => TArgs | Promise<TArgs>;
	serializeReturn?: (result: Awaited<TReturn>) => unknown | Promise<unknown>;
	getTransferables?: (result: unknown) => Transferable[];
	guestDeserialize?: string;
	fireAndForget?: boolean;
}): HostFunction {
	return config as unknown as HostFunction;
}

export interface RunCodeArgs {
	/** The bundled JavaScript code to execute */
	code: string;
	/** Host-provided functions to inject as globals in the execution context */
	hostFunctions?: HostFunction[];
}

/** Console method that produced a log entry */
export type LogLevel = "log" | "info" | "debug" | "warn" | "error";

/** A single console output captured during execution, in time order */
export interface LogEntry {
	/** Which console method was called */
	level: LogLevel;
	/** The formatted text content */
	text: string;
}

/**
 * A structured-clone-safe description of an error that terminated execution.
 *
 * Carries the same shape on both sides of a cross-boundary runner, so the
 * host can reconstruct enough of the failure to report it. The `stack` is
 * populated by the native runner and the worker runner (where guest frames are
 * named `sandlot://run.js`); it may be absent for other transports.
 */
export interface RunError {
	message: string;
	name?: string;
	stack?: string;
}

/**
 * The result of executing bundled code.
 *
 * This is deliberately presentation-agnostic: it captures *what happened*
 * (the ordered console log, and whether execution succeeded) but not how to
 * render it. CLI-style concerns (stdout/stderr streams, exit codes) live in
 * the formatting layer (`src/format`), not here.
 */
export interface RunCodeResult {
	/** True if the code ran to completion without throwing. */
	ok: boolean;
	/** All log entries in time order, for interleaved display. */
	log: LogEntry[];
	/** The error that terminated execution, present only when `ok` is false. */
	error?: RunError;
}

/**
 * Execute bundled JavaScript code and return the result.
 *
 * Implementations are responsible for providing a console object
 * and capturing its output, as well as injecting any supplied
 * {@link HostFunction}s into the execution context.
 */
export type RunFn = (args: RunCodeArgs) => Promise<RunCodeResult>;
