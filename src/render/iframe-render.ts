/**
 * Iframe-based {@link RenderFn} implementation.
 *
 * Creates a {@link RenderFn} that mounts bundled JS + CSS inside a
 * provided iframe element via `srcdoc`. Each call tears down the
 * previous render and replaces it with the new content.
 *
 * Host function calls from the iframe guest are dispatched via
 * `postMessage` over an {@link IframeTransport} scoped by a unique
 * `channelId` per render session.
 *
 * Architecture:
 * ```
 *  Host (createIframeRenderFn) ←→ IframeTransport ←→ Iframe document (preamble)
 * ```
 */

import { createConsoleHostFunctions } from "../host-functions/console";
import {
	buildRegistry,
	dispatchHostCall,
	hydrateCallbacks,
} from "../run/host-handler";
import type {
	CallbackInvokeMessage,
	CallbackReleaseMessage,
	ConsoleMessage,
	DoneMessage,
	EvalResultMessage,
	HostCallMessage,
} from "../run/protocol";
import { buildResult, mergeHostFunctions } from "../run/shared";
import type { LogEntry, RunError } from "../run/types";
import { generateIframePreamble } from "./iframe-preamble";
import { createIframeTransport } from "./iframe-transport";
import type {
	EvaluateResult,
	RenderFn,
	RenderHandle,
	RenderResult,
} from "./types";

let nextChannelId = 0;

function makeChannelId(): string {
	return `__sandlot_render_${nextChannelId++}_${Date.now()}`;
}

/**
 * Build a complete HTML document string for injection via `srcdoc`.
 */
function assembleHtml(preamble: string, css?: string): string {
	const styleBlock = css ? `<style>${css}</style>` : "";
	return `<!doctype html>
<html>
<head><meta charset="utf-8">${styleBlock}</head>
<body>
<div id="root"></div>
<script>${preamble}</script>
</body>
</html>`;
}

export interface IframeRenderOptions {
	/**
	 * Target origin for postMessage calls. Defaults to `"*"`.
	 * Use a specific origin in production for security.
	 */
	targetOrigin?: string;
}

/**
 * Create a {@link RenderFn} that mounts content inside the given iframe.
 *
 * Each call to the returned function tears down the previous render
 * (if any) and replaces the iframe content with the new build output.
 *
 * @param iframe  - The target iframe element to render into
 * @param options - Optional configuration
 */
export function createIframeRenderFn(
	iframe: HTMLIFrameElement,
	_options?: IframeRenderOptions,
): RenderFn {
	const sandboxTokens = new Set(
		(iframe.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean),
	);
	sandboxTokens.add("allow-scripts");
	sandboxTokens.add("allow-forms");
	iframe.setAttribute("sandbox", [...sandboxTokens].join(" "));

	let activeHandle: RenderHandle | null = null;

	return (args): RenderHandle => {
		// Tear down previous render
		if (activeHandle) {
			activeHandle.close();
			activeHandle = null;
		}

		const log: LogEntry[] = [];
		const channelId = makeChannelId();

		// Merge console host functions with user-provided ones
		const consoleFns = createConsoleHostFunctions((level, text) => {
			log.push({ level, text });
		});
		const userFns = args.hostFunctions ?? [];
		const allFns = mergeHostFunctions(consoleFns, userFns);

		const registry = buildRegistry(allFns);
		const preamble = generateIframePreamble(allFns, channelId);
		const html = assembleHtml(preamble, args.css);

		// Create the transport (starts listening for messages immediately)
		const transport = createIframeTransport(iframe, channelId);

		let resultResolve: (r: RenderResult) => void;
		let resolved = false;
		const result = new Promise<RenderResult>((resolve) => {
			resultResolve = resolve;
		});

		function complete(error?: RunError) {
			if (resolved) return;
			resolved = true;
			resultResolve(buildResult(log, error));
		}

		// Evaluate request/response correlation state.
		let closed = false;
		let nextEvalId = 0;
		const pendingEvals = new Map<number, (r: EvaluateResult) => void>();

		// The preamble's "ready" message gates evaluation: a call issued before
		// the iframe handler is installed waits here instead of being dropped.
		let readyResolve!: () => void;
		const readyPromise = new Promise<void>((resolve) => {
			readyResolve = resolve;
		});

		// Wire up host-side message dispatch.
		// The iframe preamble sends a "ready" message once its message
		// handler is installed, which is the reliable signal to send exec
		// (the iframe load event can fire spuriously on srcdoc reassignment).
		const sendCallback = (
			msg: CallbackInvokeMessage | CallbackReleaseMessage,
		) => {
			transport.send(msg);
		};

		let execSent = false;
		transport.onMessage((raw: unknown) => {
			const msg = raw as
				| { type: "ready" }
				| HostCallMessage
				| ConsoleMessage
				| DoneMessage
				| EvalResultMessage;

			switch (msg.type) {
				case "ready":
					readyResolve();
					if (!execSent) {
						execSent = true;
						transport.send({ type: "exec", code: args.code });
					}
					break;

				case "host-call": {
					const hf = registry.get(msg.fnId);
					if (hf?.fireAndForget) {
						const hydrated = hydrateCallbacks(msg.args, sendCallback);
						try {
							hf.fn(...hydrated);
						} catch {
							// fire-and-forget: swallow errors
						}
					} else {
						void dispatchHostCall(registry, msg, sendCallback).then(
							({ result, error, transfer }) => {
								transport.send(
									{
										type: "host-response",
										callId: msg.callId,
										...(error ? { error } : { result }),
									},
									transfer,
								);
							},
						);
					}
					break;
				}

				case "console":
					log.push({ level: msg.level, text: msg.text });
					break;

				case "done":
					complete(
						msg.ok
							? undefined
							: (msg.error ?? { message: "Execution failed" }),
					);
					break;

				case "eval-result": {
					const resolve = pendingEvals.get(msg.evalId);
					if (resolve) {
						pendingEvals.delete(msg.evalId);
						resolve({
							ok: !msg.error,
							value: msg.result,
							error: msg.error,
						});
					}
					break;
				}
			}
		});

		// Mount the HTML — exec is triggered by the preamble's "ready" message
		iframe.srcdoc = html;

		const handle: RenderHandle = {
			result,
			getLog() {
				return [...log];
			},
			async evaluate<T = unknown>(
				code: string,
				...evalArgs: unknown[]
			): Promise<EvaluateResult<T>> {
				await readyPromise;
				if (closed) {
					return { ok: false, error: { message: "Render closed" } };
				}
				const evalId = nextEvalId++;
				return new Promise<EvaluateResult<T>>((resolve) => {
					pendingEvals.set(
						evalId,
						resolve as (r: EvaluateResult) => void,
					);
					transport.send({ type: "eval", evalId, code, args: evalArgs });
				});
			},
			close() {
				closed = true;
				transport.close();
				complete();
				for (const resolve of pendingEvals.values()) {
					resolve({ ok: false, error: { message: "Render closed" } });
				}
				pendingEvals.clear();
				activeHandle = null;
			},
		};

		activeHandle = handle;
		return handle;
	};
}
