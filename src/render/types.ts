/**
 * Types for the render module.
 *
 * A {@link RenderFn} bundles and mounts code + CSS inside an iframe,
 * returning a {@link RenderHandle} for lifecycle control. This is the
 * visual counterpart of {@link RunFn}: long-running, but rendering
 * into a DOM context instead of running headlessly in a Worker.
 */

import type { HostFunction, LogEntry, RunCodeResult, RunError } from "../run/types";

// ---------------------------------------------------------------------------
// Render args, result, handle
// ---------------------------------------------------------------------------

export interface RenderArgs {
	/** The bundled JavaScript code to execute inside the iframe. */
	code: string;
	/** Combined CSS to inject as a <style> block in the iframe document. */
	css?: string;
	/** Host-provided functions to inject as globals in the execution context. */
	hostFunctions?: HostFunction[];
}

/** Result of a completed render session. Same shape as RunCodeResult. */
export type RenderResult = RunCodeResult;

/**
 * Result of an {@link RenderHandle.evaluate} call.
 *
 * Mirrors the non-throwing {@link RunCodeResult} model: a guest error never
 * rejects the promise — it surfaces as `{ ok: false, error }`. On success
 * `value` holds the structured-cloned return value of the evaluated code.
 */
export interface EvaluateResult<T = unknown> {
	/** True if the code ran to completion and its return value was serializable. */
	ok: boolean;
	/** The structured-cloned return value (present on success). */
	value?: T;
	/** The error that terminated evaluation or serialization (present on failure). */
	error?: RunError;
}

/** A handle to an active render session inside an iframe. */
export interface RenderHandle {
	/** Resolves when the rendered code finishes executing (or is closed). */
	result: Promise<RenderResult>;
	/** Snapshot of the in-memory log so far. */
	getLog(): LogEntry[];
	/**
	 * Run JavaScript inside the live, already-mounted iframe realm and return
	 * its value. The code is treated as an async function body that may `return`
	 * a value and may reference `__args` (the trailing arguments). It runs with
	 * the same injected host functions (e.g. `Sand.fs.*`, `console`) as the
	 * mounted code, and shares the iframe's DOM/`window`.
	 *
	 * Return values are structured-cloned back to the host; non-cloneable
	 * results (e.g. DOM nodes) resolve as `{ ok: false }` with a serialization
	 * error. Callers typically `await handle.result` first so the mount has
	 * finished before evaluating.
	 */
	evaluate<T = unknown>(
		code: string,
		...args: unknown[]
	): Promise<EvaluateResult<T>>;
	/** Tear down the render: close transport, resolve result. */
	close(): void;
}

/**
 * Mount bundled code + CSS inside an iframe and return a handle.
 *
 * Each call tears down any previous render on the same iframe and
 * replaces it with the new content.
 */
export type RenderFn = (args: RenderArgs) => RenderHandle;
