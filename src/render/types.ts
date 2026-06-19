/**
 * Types for the render module.
 *
 * A {@link RenderFn} bundles and mounts code + CSS inside an iframe,
 * returning a {@link RenderHandle} for lifecycle control. This is the
 * visual counterpart of {@link RunFn}: long-running, but rendering
 * into a DOM context instead of running headlessly in a Worker.
 */

import type { EvalHandleToken } from "../run/protocol";
import type { HostFunction, LogEntry, RunCodeResult, RunError } from "../run/types";

export type { EvalHandleToken } from "../run/protocol";

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
	/** The structured-cloned return value (present on a successful by-value `evaluate`). */
	value?: T;
	/**
	 * Reference to the kept return value (present on a successful `evaluateHandle`).
	 * The referenced object stays inside the iframe; pass the token back in a
	 * later `evaluate`/`evaluateHandle` `...args` to operate on it.
	 */
	handle?: EvalHandleToken;
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
	/**
	 * Like {@link RenderHandle.evaluate}, but keeps the top-level return value
	 * inside the iframe and resolves with an {@link EvalHandleToken} (in the
	 * `handle` field) instead of structured-cloning it back. Use this for
	 * non-serializable values (DOM nodes, class instances): hold the token and
	 * pass it into later `evaluate`/`evaluateHandle` calls via `...args`, where
	 * it is re-hydrated into the live object. Release it with
	 * {@link RenderHandle.releaseHandle}. Handles are invalidated when the render
	 * is torn down or replaced.
	 */
	evaluateHandle(
		code: string,
		...args: unknown[]
	): Promise<EvaluateResult>;
	/** Release a handle previously returned by {@link RenderHandle.evaluateHandle}. */
	releaseHandle(token: EvalHandleToken): void;
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
