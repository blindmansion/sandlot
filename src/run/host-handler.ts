/**
 * Host-side message handling for cross-boundary execution.
 *
 * This module provides two levels of abstraction:
 *
 * 1. {@link handleExecution} — Manages a single execution session on a
 *    direct transport to a worker. Sends `exec`, dispatches host-calls,
 *    collects output, resolves when `done`.
 *
 * 2. {@link HostSessionManager} — Manages multiple concurrent execution
 *    sessions over a single transport to an {@link IframeOrchestrator}.
 *    Each session is identified by a `workerId` and independently
 *    dispatches host-calls, collects output, and resolves on completion.
 */

import type { Transferable } from "bun";
import { joinOutputLines } from "./cli-output";
import { createConsoleHostFunctions } from "../host-functions/console";
import { generateGuestPreamble } from "./guest-preamble";
import type {
	CallbackInvokeMessage,
	CallbackReleaseMessage,
	ConsoleMessage,
	DoneMessage,
	HostCallMessage,
	OrchestratorMessage,
	Transport,
	WorkerTagged,
} from "./protocol";
import { mergeHostFunctions } from "./shared";
import type { HostFunction, LogEntry, LogLevel, RunCodeResult } from "./types";

const STDOUT_LEVELS: LogLevel[] = ["log", "info", "debug"];
const STDERR_LEVELS: LogLevel[] = ["warn", "error"];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Build the final RunCodeResult from collected logs and an exit code. */
function buildResult(log: LogEntry[], exitCode: number): RunCodeResult {
	const stdout = joinOutputLines(
		log.filter((e) => STDOUT_LEVELS.includes(e.level)).map((e) => e.text),
	);

	const stderr = joinOutputLines(
		log.filter((e) => STDERR_LEVELS.includes(e.level)).map((e) => e.text),
	);

	return { exitCode, stdout, stderr, log };
}

/** Build a host function lookup table keyed by dot-joined path. */
export function buildRegistry(
	hostFunctions: HostFunction[],
): Map<string, HostFunction> {
	const registry = new Map<string, HostFunction>();
	for (const hf of hostFunctions) {
		if (hf.path.length === 0) continue;
		registry.set(hf.path.join("."), hf);
	}
	return registry;
}

/** Sentinel property used to identify serialized callback references in args. */
const CALLBACK_SENTINEL = "__sandlot_cb__";

/**
 * Replace serialized callback markers in args with callable proxy functions.
 *
 * The guest preamble serializes function arguments as
 * `{ __sandlot_cb__: callbackId }`. This function replaces those markers
 * with real functions that, when called, send a `callback-invoke` message
 * back to the guest through the provided `send` function.
 *
 * Only scans the top-level args array (no deep traversal). Hydrated callbacks
 * expose `release()` so long-lived host subscriptions can free the guest-side
 * callback when they unsubscribe.
 */
export function hydrateCallbacks(
	args: unknown[],
	send: (msg: CallbackInvokeMessage | CallbackReleaseMessage) => void,
): unknown[] {
	return args.map((arg) => {
		if (
			arg !== null &&
			typeof arg === "object" &&
			CALLBACK_SENTINEL in (arg as Record<string, unknown>)
		) {
			const callbackId = (arg as Record<string, unknown>)[
				CALLBACK_SENTINEL
			] as number;
			const callback = (...cbArgs: unknown[]) => {
				send({ type: "callback-invoke", callbackId, args: cbArgs });
			};
			Object.defineProperties(callback, {
				__sandlotCallbackId: {
					value: callbackId,
				},
				release: {
					value: () => send({ type: "callback-release", callbackId }),
				},
			});
			return callback;
		}
		return arg;
	});
}

/**
 * Dispatch a host function call: look up, run the pipeline
 * (hydrateCallbacks → deserializeArgs → fn → serializeReturn → getTransferables),
 * and return the response data.
 *
 * @param registry - Host function lookup table
 * @param msg      - The incoming host-call message
 * @param send     - Optional send function for callback proxying. When
 *   provided, serialized callback markers in args are replaced with
 *   callable proxy functions before calling `fn()`. Omit for contexts
 *   where callbacks are not supported (or not needed).
 */
export async function dispatchHostCall(
	registry: Map<string, HostFunction>,
	msg: HostCallMessage,
	send?: (msg: CallbackInvokeMessage | CallbackReleaseMessage) => void,
): Promise<{
	result?: unknown;
	error?: { message: string; name?: string };
	transfer?: Transferable[];
}> {
	const hf = registry.get(msg.fnId);

	if (!hf) {
		return {
			error: {
				message: `Unknown host function: ${msg.fnId}`,
				name: "Error",
			},
		};
	}

	try {
		// Hydrate any serialized callback markers into proxy functions
		let args: unknown[] = send ? hydrateCallbacks(msg.args, send) : msg.args;

		// Optionally deserialize args (may be sync or async)
		if (hf.deserializeArgs) {
			const deserialized = hf.deserializeArgs(args);
			args =
				deserialized instanceof Promise ? await deserialized : deserialized;
		}

		// Call the host function (may be sync or async)
		let result = hf.fn(...args);
		if (result instanceof Promise) {
			result = await result;
		}

		// Optionally serialize the return value (may be sync or async)
		let serialized = hf.serializeReturn ? hf.serializeReturn(result) : result;
		if (serialized instanceof Promise) {
			serialized = await serialized;
		}

		// Optionally extract transferables
		const transfer = hf.getTransferables
			? hf.getTransferables(serialized)
			: undefined;

		return { result: serialized, transfer };
	} catch (err) {
		return {
			error: {
				message: err instanceof Error ? err.message : String(err),
				name: err instanceof Error ? err.name : "Error",
			},
		};
	}
}

// ---------------------------------------------------------------------------
// Multi-session manager (orchestrator transport)
// ---------------------------------------------------------------------------

/**
 * An active execution session tracked by the {@link HostSessionManager}.
 */
class Session {
	readonly log: LogEntry[] = [];
	readonly result: Promise<RunCodeResult>;
	private _resolve!: (result: RunCodeResult) => void;
	private resolved = false;

	constructor() {
		this.result = new Promise<RunCodeResult>((resolve) => {
			this._resolve = resolve;
		});
	}

	/** Resolve the session's result promise. Idempotent. */
	complete(exitCode: number): void {
		if (this.resolved) return;
		this.resolved = true;
		this._resolve(buildResult(this.log, exitCode));
	}
}

/**
 * Manages multiple concurrent execution sessions over a single transport
 * to an {@link IframeOrchestrator}.
 *
 * Each {@link spawn} creates a new session identified by a unique `workerId`.
 * Incoming messages are routed to the correct session by `workerId`.
 * Host function calls are dispatched from a shared registry.
 *
 * @example
 * ```ts
 * const manager = new HostSessionManager(transport, hostFunctions);
 * const { workerId, result } = manager.spawn(code);
 * const output = await result;
 * manager.close();
 * ```
 */
export class HostSessionManager {
	private readonly registry: Map<string, HostFunction>;
	private readonly preamble: string;
	private readonly sessions = new Map<string, Session>();
	private nextId = 0;
	private _activeLog: LogEntry[] | null = null;

	constructor(
		private readonly transport: Transport,
		hostFunctions: HostFunction[],
	) {
		const consoleFns = createConsoleHostFunctions((level, text) => {
			this._activeLog?.push({ level, text });
		});
		const allFns = mergeHostFunctions(consoleFns, hostFunctions);
		this.registry = buildRegistry(allFns);
		this.preamble = generateGuestPreamble(allFns);

		transport.onMessage((raw) => this.handleMessage(raw));
	}

	/**
	 * Spawn a new worker and execute code.
	 *
	 * @returns The workerId and a promise that resolves with the execution result.
	 */
	spawn(code: string): { workerId: string; result: Promise<RunCodeResult> } {
		const workerId = String(this.nextId++);
		const session = new Session();
		this.sessions.set(workerId, session);

		this.transport.send({
			type: "spawn",
			workerId,
			preamble: this.preamble,
			code,
		});

		return { workerId, result: session.result };
	}

	/**
	 * Terminate a worker. If the session is still active, its result
	 * promise resolves with exit code 137 (killed).
	 */
	kill(workerId: string): void {
		this.transport.send({ type: "kill", workerId });
		const session = this.sessions.get(workerId);
		if (session) {
			session.complete(137);
			this.sessions.delete(workerId);
		}
	}

	/** Snapshot of the log for an active session, or null if not found. */
	getSessionLog(workerId: string): LogEntry[] | null {
		const session = this.sessions.get(workerId);
		return session ? [...session.log] : null;
	}

	/** Number of active sessions. */
	get size(): number {
		return this.sessions.size;
	}

	/** Kill all active sessions and close the transport. */
	close(): void {
		for (const id of this.sessions.keys()) {
			this.kill(id);
		}
		this.transport.close();
	}

	// -----------------------------------------------------------------------
	// Internal message routing
	// -----------------------------------------------------------------------

	private sendCallback(
		workerId: string,
	): (msg: CallbackInvokeMessage | CallbackReleaseMessage) => void {
		return (msg) => {
			this.transport.send({ ...msg, workerId });
		};
	}

	private handleMessage(raw: unknown): void {
		const msg = raw as OrchestratorMessage;
		const session = this.sessions.get(msg.workerId);
		if (!session) return;

		switch (msg.type) {
			case "host-call": {
				const hf = this.registry.get(msg.fnId);
				if (hf?.fireAndForget) {
					this._activeLog = session.log;
					const args = hydrateCallbacks(
						msg.args,
						this.sendCallback(msg.workerId),
					);
					try {
						hf.fn(...args);
					} catch {
						// fire-and-forget: swallow errors
					}
					this._activeLog = null;
				} else {
					void this.handleHostCall(msg as WorkerTagged<HostCallMessage>);
				}
				break;
			}

			case "console":
				session.log.push({ level: msg.level, text: msg.text });
				break;

			case "done":
				session.complete(msg.exitCode);
				this.sessions.delete(msg.workerId);
				break;
		}
	}

	private async handleHostCall(
		msg: WorkerTagged<HostCallMessage>,
	): Promise<void> {
		const { workerId } = msg;
		const { result, error, transfer } = await dispatchHostCall(
			this.registry,
			msg,
			this.sendCallback(workerId),
		);
		this.transport.send(
			{
				type: "host-response",
				workerId,
				callId: msg.callId,
				...(error ? { error } : { result }),
			},
			transfer,
		);
	}
}
