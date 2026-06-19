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
	/** 0 for success, non-zero for failure. */
	exitCode: number;
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
