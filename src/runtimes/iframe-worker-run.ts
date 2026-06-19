/**
 * Browser iframe + Worker RunFn implementation.
 *
 * The parent page owns host functions and result collection. The sandboxed
 * iframe owns the Worker lifecycle, matching the runtime shape described by
 * `IframeOrchestrator` while using a browser `postMessage` boundary.
 */

import { HostSessionManager } from "../toolchain/run/host-handler";
import type { Transferable } from "bun";
import type { Transport } from "../toolchain/run/protocol";
import type { HostFunction, RunCodeResult, RunFn } from "../toolchain/run/types";

let nextChannelId = 0;

function makeChannelId(): string {
	return `__sandlot_iframe_worker_${nextChannelId++}_${Date.now()}`;
}

interface IframeWorkerTransport extends Transport {
	ready: Promise<void>;
}

type IframeWorkerContentWindow = {
	postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
};

declare const window: {
	addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
	removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
};

export type IframeWorkerFrame = {
	contentWindow: IframeWorkerContentWindow | null;
	getAttribute(name: string): string | null;
	setAttribute(name: string, value: string): void;
	srcdoc: string;
};

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
	});

	return Promise.race([promise, timeout]).finally(() => {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
		}
	});
}

function createIframeWorkerTransport(
	iframe: IframeWorkerFrame,
	channelId: string,
): IframeWorkerTransport {
	let handler: ((msg: unknown) => void) | null = null;
	let closed = false;
	let readyResolve!: () => void;
	const ready = new Promise<void>((resolve) => {
		readyResolve = resolve;
	});

	const listener = (event: MessageEvent) => {
		if (event.source !== iframe.contentWindow) return;
		const data = event.data as { __channelId?: string; type?: string } | undefined;
		if (data?.__channelId !== channelId) return;
		if (data.type === "ready") {
			readyResolve();
			return;
		}
		handler?.(data);
	};

	window.addEventListener("message", listener);

	return {
		ready,
		send(msg: unknown, transfer) {
			if (closed || !iframe.contentWindow) return;
			const envelope = { ...(msg as object), __channelId: channelId };
			if (transfer && transfer.length > 0) {
				iframe.contentWindow.postMessage(envelope, "*", transfer);
			} else {
				iframe.contentWindow.postMessage(envelope, "*");
			}
		},
		onMessage(cb: (msg: unknown) => void) {
			handler = cb;
		},
		close() {
			if (closed) return;
			closed = true;
			handler = null;
			iframe.contentWindow?.postMessage({ type: "close", __channelId: channelId }, "*");
			window.removeEventListener("message", listener);
		},
	};
}

export interface IframeWorkerRunOptions {
	/**
	 * Optional hook for observing each run's channel id, mostly useful for
	 * debugging browser postMessage traffic.
	 */
	onChannelId?: (channelId: string) => void;
	/**
	 * How long to wait for the sandbox iframe to report that its orchestrator
	 * is ready before failing the run.
	 *
	 * @default 5000
	 */
	readyTimeoutMs?: number;
}

/**
 * Create a RunFn that executes bundled code in browser Workers owned by a
 * sandboxed iframe.
 */
export function createIframeWorkerRunFn(
	iframe: IframeWorkerFrame,
	options?: IframeWorkerRunOptions,
): RunFn {
	const sandboxTokens = new Set(
		(iframe.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean),
	);
	sandboxTokens.add("allow-scripts");
	iframe.setAttribute("sandbox", [...sandboxTokens].join(" "));
	const readyTimeoutMs = options?.readyTimeoutMs ?? 5000;
	let queue = Promise.resolve();

	async function execute(
		code: string,
		hostFunctions: HostFunction[],
	): Promise<RunCodeResult> {
		const channelId = makeChannelId();
		options?.onChannelId?.(channelId);

		const transport = createIframeWorkerTransport(iframe, channelId);
		const manager = new HostSessionManager(transport, hostFunctions ?? []);

		try {
			iframe.srcdoc = generateIframeWorkerPreamble(channelId);
			await withTimeout(
				transport.ready,
				readyTimeoutMs,
				"Timed out waiting for iframe worker runner to become ready.",
			);

			const { result } = manager.spawn(code);
			return await result;
		} finally {
			manager.close();
		}
	}

	return ({ code, hostFunctions }): Promise<RunCodeResult> => {
		const run = queue
			.catch(() => {
				// Keep the queue alive after a failed run.
			})
			.then(() => execute(code, hostFunctions ?? []));
		queue = run.then(
			() => { },
			() => { },
		);
		return run;
	};
}

/**
 * Generate the HTML document that hosts the browser worker orchestrator.
 *
 * This is the browser counterpart to the in-process `LinkedTransportPair`
 * setup used by `createWorkerRunFn`: the parent page talks to this iframe via
 * `postMessage`, and the iframe owns the actual Workers.
 */

export function generateIframeWorkerPreamble(channelId: string): string {
	const channelIdJson = JSON.stringify(channelId);

	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8" />
</head>
<body>
	<script>
const __channelId = ${channelIdJson};
let __hostMessageHandler = null;
const __workers = new Map();

function __sendToHost(message, transfer) {
	window.parent.postMessage({ ...message, __channelId }, "*", transfer || []);
}

const __hostTransport = {
	send(message, transfer) {
		__sendToHost(message, transfer);
	},
	onMessage(callback) {
		__hostMessageHandler = callback;
	},
	close() {
		__hostMessageHandler = null;
	}
};

function __cleanupWorker(workerId) {
	const entry = __workers.get(workerId);
	if (!entry) return;
	entry.worker.terminate();
	URL.revokeObjectURL(entry.blobUrl);
	__workers.delete(workerId);
}

function __handleSpawn(message) {
	const { workerId, preamble, code } = message;
	let blobUrl = "";
	let worker = null;

	try {
		const blob = new Blob([preamble], { type: "application/javascript" });
		blobUrl = URL.createObjectURL(blob);
		worker = new Worker(blobUrl);
	} catch (error) {
		if (blobUrl) URL.revokeObjectURL(blobUrl);
		const message = error instanceof Error ? error.message : String(error);
		__hostTransport.send({
			type: "done",
			workerId,
			ok: false,
			error: { message, name: error instanceof Error ? error.name : "Error" }
		});
		return;
	}

	worker.onmessage = (event) => {
		const data = event.data;
		__hostTransport.send({ ...data, workerId });

		if (data && data.type === "done") {
			__cleanupWorker(workerId);
		}
	};

	worker.onerror = (event) => {
		__hostTransport.send({
			type: "done",
			workerId,
			ok: false,
			error: { message: event.message || "Worker error", name: "WorkerError" }
		});
		__cleanupWorker(workerId);
	};

	__workers.set(workerId, { worker, blobUrl });
	worker.postMessage({ type: "exec", code });
}

function __handleKill(message) {
	if (__workers.has(message.workerId)) {
		__cleanupWorker(message.workerId);
		__hostTransport.send({
			type: "done",
			workerId: message.workerId,
			ok: false,
			error: { message: "Worker terminated", name: "KilledError" }
		});
	}
}

function __routeToWorker(message) {
	const entry = __workers.get(message.workerId);
	if (!entry) return;
	const { workerId, __channelId: _channelId, ...innerMessage } = message;
	entry.worker.postMessage(innerMessage);
}

__hostTransport.onMessage((message) => {
	try {
		switch (message.type) {
			case "spawn":
				__handleSpawn(message);
				break;
			case "kill":
				__handleKill(message);
				break;
			case "host-response":
			case "callback-invoke":
			case "callback-release":
				__routeToWorker(message);
				break;
		}
	} catch (error) {
		if ("workerId" in message) {
			__hostTransport.send({
				type: "done",
				workerId: message.workerId,
				ok: false,
				error: {
					message: error instanceof Error ? error.message : String(error),
					name: error instanceof Error ? error.name : "Error"
				}
			});
		} else {
			__sendToHost({
				type: "console",
				workerId: "unknown",
				level: "error",
				text: error instanceof Error ? error.message : String(error)
			});
		}
	}
});

window.addEventListener("message", (event) => {
	if (event.source !== window.parent) return;
	const message = event.data;
	if (!message || message.__channelId !== __channelId) return;
	if (message.type === "close") {
		for (const workerId of Array.from(__workers.keys())) {
			__cleanupWorker(workerId);
		}
		__hostTransport.close();
		return;
	}
	__hostMessageHandler?.(message);
});

window.addEventListener("pagehide", () => {
	for (const workerId of Array.from(__workers.keys())) {
		__cleanupWorker(workerId);
	}
});

__sendToHost({ type: "ready" });
	</script>
</body>
</html>`;
}

