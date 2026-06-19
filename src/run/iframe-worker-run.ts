/**
 * Browser iframe + Worker RunFn implementation.
 *
 * The parent page owns host functions and result collection. The sandboxed
 * iframe owns the Worker lifecycle, matching the runtime shape described by
 * `IframeOrchestrator` while using a browser `postMessage` boundary.
 */

import { HostSessionManager } from "./host-handler";
import { generateIframeWorkerPreamble } from "./iframe-worker-preamble";
import type { Transport } from "./protocol";
import type { HostFunction, RunCodeResult, RunFn } from "./types";

let nextChannelId = 0;

function makeChannelId(): string {
	return `__sandlot_iframe_worker_${nextChannelId++}_${Date.now()}`;
}

interface IframeWorkerTransport extends Transport {
	ready: Promise<void>;
}

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
	iframe: HTMLIFrameElement,
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
	iframe: HTMLIFrameElement,
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
			() => {},
			() => {},
		);
		return run;
	};
}
