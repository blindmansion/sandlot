/**
 * Types for the render module.
 *
 * A {@link RenderFn} bundles and mounts code + CSS inside an iframe,
 * returning a {@link RenderHandle} for lifecycle control. This is the
 * visual counterpart of {@link RunFn}: long-running, but rendering
 * into a DOM context instead of running headlessly in a Worker.
 */

import type { HostFunction, LogEntry, RunCodeResult } from "../run/types";

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

/** A handle to an active render session inside an iframe. */
export interface RenderHandle {
	/** Resolves when the rendered code finishes executing (or is closed). */
	result: Promise<RenderResult>;
	/** Snapshot of the in-memory log so far. */
	getLog(): LogEntry[];
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
