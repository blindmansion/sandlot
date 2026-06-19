/**
 * Transport implementation for iframe ↔ host communication.
 *
 * Uses `postMessage` / `addEventListener("message")` across the iframe
 * boundary, with a `channelId` tag on every message to prevent crosstalk
 * when multiple iframes share the same parent window.
 *
 * The iframe guest (preamble) tags outgoing messages with `__channelId`
 * and filters incoming messages by the same value. This transport does
 * the mirror operation on the host side.
 */

import type { Transport } from "../run/protocol";

/** Message envelope used on the wire between host and iframe. */
export interface ChannelEnvelope {
	__channelId: string;
	[key: string]: unknown;
}

/**
 * Create a {@link Transport} that communicates with an iframe via
 * `postMessage`, scoped to a specific `channelId`.
 *
 * @param iframe    - The target iframe element
 * @param channelId - Unique identifier for this render session
 */
export function createIframeTransport(
	iframe: HTMLIFrameElement,
	channelId: string,
): Transport {
	let handler: ((msg: unknown) => void) | null = null;

	const listener = (event: MessageEvent) => {
		if (event.source !== iframe.contentWindow) return;
		const data = event.data as ChannelEnvelope | undefined;
		if (data?.__channelId !== channelId) return;
		handler?.(data);
	};

	window.addEventListener("message", listener);

	return {
		send(msg: unknown) {
			if (!iframe.contentWindow) return;
			const envelope = { ...(msg as object), __channelId: channelId };
			iframe.contentWindow.postMessage(envelope, "*");
		},

		onMessage(cb: (msg: unknown) => void) {
			handler = cb;
		},

		close() {
			handler = null;
			window.removeEventListener("message", listener);
		},
	};
}
