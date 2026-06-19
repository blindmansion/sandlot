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
		__hostTransport.send({
			type: "console",
			workerId,
			level: "error",
			text: error instanceof Error ? error.message : String(error)
		});
		__hostTransport.send({
			type: "done",
			workerId,
			exitCode: 1
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
			type: "console",
			workerId,
			level: "error",
			text: event.message || "Worker error"
		});
		__hostTransport.send({
			type: "done",
			workerId,
			exitCode: 1
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
			exitCode: 137
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
				type: "console",
				workerId: message.workerId,
				level: "error",
				text: error instanceof Error ? error.message : String(error)
			});
			__hostTransport.send({
				type: "done",
				workerId: message.workerId,
				exitCode: 1
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
