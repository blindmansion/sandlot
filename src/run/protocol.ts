/**
 * Cross-boundary message protocol and transport abstraction.
 *
 * Defines the message types exchanged between host and guest across
 * a postMessage-like boundary (web worker, iframe, MessageChannel),
 * plus a minimal Transport interface that both sides use.
 *
 * The protocol has two layers:
 *
 * **Inner protocol** (orchestrator ↔ worker): The base message types
 * used for direct communication between the orchestrator and individual
 * workers. Workers are unaware of their own identity.
 *
 * **Outer protocol** (host ↔ orchestrator): Extends the inner types
 * with a `workerId` for multiplexing multiple workers over a single
 * transport, plus management messages (spawn, kill).
 */

import type { Transferable } from "bun";
import type { LogLevel } from "./types";

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * A minimal bidirectional message channel.
 *
 * Wraps any postMessage-like boundary: Bun Worker, browser Worker,
 * MessagePort, or an in-process relay.
 */
export interface Transport {
	/** Send a message (and optionally transfer ownership of objects). */
	send(msg: unknown, transfer?: Transferable[]): void;
	/** Register a callback for incoming messages. */
	onMessage(cb: (msg: unknown) => void): void;
	/** Tear down the channel (remove listeners, terminate worker, etc.). */
	close(): void;
}

// ---------------------------------------------------------------------------
// Inner protocol: Orchestrator ↔ Worker
// ---------------------------------------------------------------------------

/**
 * Orchestrator → Worker: execute code.
 */
export interface ExecMessage {
	type: "exec";
	/** The bundled JavaScript to execute. */
	code: string;
}

/**
 * Host → Iframe (render): evaluate code inside the already-mounted iframe
 * realm and return its value.
 *
 * Distinct from {@link ExecMessage}: `exec` is the one-shot mount that ends
 * with a {@link DoneMessage}, whereas `eval` can be issued repeatedly against
 * a live render and each is answered by an {@link EvalResultMessage} correlated
 * by `evalId`.
 */
export interface EvalMessage {
	type: "eval";
	/** Unique evaluation identifier (incrementing counter). */
	evalId: number;
	/**
	 * JavaScript to run. Treated as an async function body that may `return`
	 * a value and may reference `__args`.
	 */
	code: string;
	/**
	 * Arguments exposed to the evaluated code as `__args`. Each may be a
	 * structured-cloneable value or an {@link EvalHandleToken} referencing a
	 * previously-returned non-serializable object; tokens are re-hydrated into
	 * the live object inside the iframe before the code runs.
	 */
	args: unknown[];
	/**
	 * When true, the top-level return value is kept inside the iframe and
	 * referenced by an {@link EvalHandleToken} instead of being structured-cloned
	 * back to the host. Lets the caller hold a reference to a non-serializable
	 * value (e.g. a DOM node) and pass it back into later evals.
	 */
	returnHandle?: boolean;
}

/**
 * An opaque reference to a value that lives inside the render iframe's realm.
 *
 * Only the integer `id` crosses the boundary; the referenced object never
 * leaves the iframe. Pass a token back in an {@link EvalMessage}'s `args` to
 * operate on the live object, and release it with a {@link HandleReleaseMessage}.
 * Handles are invalidated when the render is torn down or replaced.
 */
export interface EvalHandleToken {
	__sandlot_handle__: number;
}

/**
 * Iframe (render) → Host: the result (or error) of an {@link EvalMessage}.
 *
 * `result` is present on success (return-by-value, structured-cloned); `error`
 * is present when the evaluated code threw or its return value was not
 * serializable.
 */
export interface EvalResultMessage {
	type: "eval-result";
	/** The evalId from the corresponding EvalMessage. */
	evalId: number;
	/** The returned value, structured-cloned (present on a successful by-value eval). */
	result?: unknown;
	/**
	 * Reference to the kept return value (present on a successful eval issued
	 * with `returnHandle: true`).
	 */
	handle?: EvalHandleToken;
	/** Error info (present on failure). */
	error?: { message: string; name?: string; stack?: string };
}

/**
 * Host → Iframe (render): release a value previously kept via an
 * {@link EvalMessage} with `returnHandle: true`, freeing it from the iframe's
 * handle registry. No-op if the handle is unknown or already released.
 */
export interface HandleReleaseMessage {
	type: "handle-release";
	/** The id from the {@link EvalHandleToken} to release. */
	handleId: number;
}

/**
 * Host → Iframe (render): hot-swap the document's CSS in place.
 *
 * The render document carries a single `<style id="__sandlot_css">` block; this
 * message replaces its text content. No JS is re-executed and no module state is
 * touched, so it is the cheapest possible hot update (zero state loss). Sent
 * fire-and-forget — there is no reply to correlate.
 */
export interface CssUpdateMessage {
	type: "css-update";
	/** The full CSS text to swap into the live `<style>` block. */
	css: string;
}

/**
 * A single module to (re)register in the render runtime's registry. Mirrors the
 * render-layer `RenderModule` shape, inlined here so the protocol stays
 * independent of the render module (run must not depend on render).
 */
export interface HmrPatchModule {
	/** Absolute VFS path — the registry key. */
	path: string;
	/** The compiled module body (esbuild `cjs`/`esm` transform output). */
	code: string;
	/** Written specifier → absolute registry key, for project (non-vendor) imports. */
	deps: Record<string, string>;
	/** True when the body is an async IIFE (import-less entry with top-level await). */
	async: boolean;
}

/**
 * Host → Iframe (render): hot-patch changed modules into the live runtime.
 *
 * Each module's factory is re-registered by path; the runtime then re-runs the
 * graph from the entry (Phase 3 — no accept-boundary walk yet). Answered by an
 * {@link HmrResultMessage} correlated by `patchId`.
 */
export interface HmrPatchMessage {
	type: "hmr-patch";
	/** Correlation id for the matching {@link HmrResultMessage}. */
	patchId: number;
	/** The changed module factories to re-register before re-running the entry. */
	modules: HmrPatchModule[];
}

/**
 * Iframe (render) → Host: the outcome of an {@link HmrPatchMessage}.
 *
 * `accepted` — the runtime re-registered and re-ran the entry in place (no
 * document reload). `full-reload` — applying the patch threw (e.g. a missing
 * module, a custom element that can't be redefined); the host should fall back
 * to a fresh render.
 */
export interface HmrResultMessage {
	type: "hmr-result";
	/** The patchId from the corresponding {@link HmrPatchMessage}. */
	patchId: number;
	/** Whether the patch applied in place or the host must do a full reload. */
	outcome: "accepted" | "full-reload";
	/** Error info (present when `outcome` is `full-reload` due to a thrown error). */
	error?: { message: string; name?: string; stack?: string };
}

/**
 * Worker → Orchestrator: a host function call from the guest code.
 */
export interface HostCallMessage {
	type: "host-call";
	/** Unique call identifier (incrementing counter). */
	callId: number;
	/** Dot-joined function path, e.g. "Sand.fs.readFile". */
	fnId: string;
	/** Arguments to pass to the host function (must be structured-cloneable). */
	args: unknown[];
}

/**
 * Orchestrator → Worker: the result (or error) of a host function call.
 */
export interface HostResponseMessage {
	type: "host-response";
	/** The callId from the corresponding HostCallMessage. */
	callId: number;
	/** The return value (present on success). */
	result?: unknown;
	/** Error info (present on failure). */
	error?: { message: string; name?: string };
}

/**
 * Worker → Orchestrator: a console output captured during execution.
 */
export interface ConsoleMessage {
	type: "console";
	level: LogLevel;
	/** Formatted text content. */
	text: string;
}

/**
 * Worker → Orchestrator: execution has completed.
 */
export interface DoneMessage {
	type: "done";
	/** True if the guest code ran to completion without throwing. */
	ok: boolean;
	/** The error that terminated execution, present only when `ok` is false. */
	error?: { message: string; name?: string };
}

/**
 * Orchestrator → Worker: invoke a callback the guest previously passed
 * as an argument to a host function.
 *
 * Callbacks are fire-and-forget from the host's perspective — the host
 * does not wait for the guest to finish processing.
 */
export interface CallbackInvokeMessage {
	type: "callback-invoke";
	/** The callback identifier assigned by the guest preamble. */
	callbackId: number;
	/** Arguments to pass to the callback (must be structured-cloneable). */
	args: unknown[];
}

/**
 * Orchestrator → Worker: the host is done with this callback.
 *
 * The guest may remove the callback from its registry to free memory.
 * Optional — callbacks are also implicitly released when the guest
 * execution completes.
 */
export interface CallbackReleaseMessage {
	type: "callback-release";
	/** The callback identifier to release. */
	callbackId: number;
}

/** Any message a worker may send to the orchestrator (inner protocol). */
export type GuestMessage = HostCallMessage | ConsoleMessage | DoneMessage;

/** Any message the orchestrator may send to a worker (inner protocol). */
export type HostMessage =
	| ExecMessage
	| HostResponseMessage
	| CallbackInvokeMessage
	| CallbackReleaseMessage;

// ---------------------------------------------------------------------------
// Outer protocol: Host ↔ Orchestrator
// ---------------------------------------------------------------------------

/** Tag a message type with a workerId for multiplexed routing. */
export type WorkerTagged<T> = T & { workerId: string };

/**
 * Host → Orchestrator: create a new worker and execute code.
 */
export interface SpawnMessage {
	type: "spawn";
	/** Unique identifier for the new worker. */
	workerId: string;
	/** The guest preamble JavaScript to use as the worker script. */
	preamble: string;
	/** The bundled JavaScript code to execute. */
	code: string;
}

/**
 * Host → Orchestrator: terminate a worker.
 */
export interface KillMessage {
	type: "kill";
	/** The worker to terminate. */
	workerId: string;
}

/** Any message the orchestrator may send to the host (outer protocol). */
export type OrchestratorMessage =
	| WorkerTagged<HostCallMessage>
	| WorkerTagged<ConsoleMessage>
	| WorkerTagged<DoneMessage>;

/** Any message the host may send to the orchestrator (outer protocol). */
export type HostToOrchestratorMessage =
	| SpawnMessage
	| KillMessage
	| WorkerTagged<HostResponseMessage>
	| WorkerTagged<CallbackInvokeMessage>
	| WorkerTagged<CallbackReleaseMessage>;
