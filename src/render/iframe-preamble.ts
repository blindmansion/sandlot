/**
 * Generate the JavaScript preamble injected into the iframe document.
 *
 * This is the iframe counterpart of `guest-preamble.ts` (Worker version).
 * The key differences:
 *
 * - Uses `window.parent.postMessage` instead of `postMessage` (Worker global)
 * - Uses `window.addEventListener("message")` instead of `self.onmessage`
 * - All messages are tagged with a `__channelId` to prevent crosstalk
 *   between multiple iframes on the same page
 *
 * The stub generation and globals registry logic are identical to the
 * Worker version. The exec/host-response message handling is adapted
 * for the iframe boundary.
 */

import type { HostFunction } from "../run/types";

interface StubDef {
	fnId: string;
	path: string[];
	guestDeserialize?: string;
	fireAndForget?: boolean;
}

/**
 * Generate the full iframe preamble as a JavaScript string.
 *
 * @param hostFunctions - Host functions to generate stubs for
 * @param channelId     - Unique channel identifier for message filtering
 */
export function generateIframePreamble(
	hostFunctions: HostFunction[],
	channelId: string,
): string {
	const stubs: StubDef[] = hostFunctions
		.filter((hf) => hf.path.length > 0)
		.map((hf) => ({
			fnId: hf.path.join("."),
			path: hf.path,
			guestDeserialize: hf.guestDeserialize,
			fireAndForget: hf.fireAndForget,
		}));

	const hasRpcStubs = stubs.some((s) => !s.fireAndForget);
	const channelIdStr = JSON.stringify(channelId);

	return [
		generateHeader(channelIdStr),
		generateCallbackRegistry(),
		hasRpcStubs ? generatePromiseMap(channelIdStr) : null,
		generateStubs(stubs, channelIdStr),
		generateGlobalsRegistry(stubs),
		generateMessageHandler(hasRpcStubs, channelIdStr),
	]
		.filter(Boolean)
		.join("\n\n");
}

// ---------------------------------------------------------------------------
// Code generators
// ---------------------------------------------------------------------------

function generateHeader(channelIdStr: string): string {
	return `// --- Iframe preamble (generated) ---
"use strict";
const __channelId = ${channelIdStr};`;
}

function generateCallbackRegistry(): string {
	return `const __callbacks = new Map();
let __nextCbId = 0;

function __serializeArgs(args) {
	return args.map(function(arg) {
		if (typeof arg === "function") {
			var cbId = __nextCbId++;
			__callbacks.set(cbId, arg);
			return { __sandlot_cb__: cbId };
		}
		return arg;
	});
}`;
}

function generatePromiseMap(channelIdStr: string): string {
	return `const __pending = new Map();
let __nextId = 0;

function __callHost(fnId, args) {
	const callId = __nextId++;
	const serializedArgs = __serializeArgs(args);
	return new Promise((resolve, reject) => {
		__pending.set(callId, { resolve, reject });
		window.parent.postMessage({ type: "host-call", callId, fnId, args: serializedArgs, __channelId: ${channelIdStr} }, "*");
	});
}`;
}

function generateStubs(stubs: StubDef[], channelIdStr: string): string {
	if (stubs.length === 0) return "// (no host function stubs)";

	const lines = ["// Host function stubs"];
	for (const stub of stubs) {
		const varName = stubVarName(stub.fnId);
		const fnIdStr = JSON.stringify(stub.fnId);

		if (stub.fireAndForget) {
			lines.push(
				`const ${varName} = (...args) => { window.parent.postMessage({ type: "host-call", callId: -1, fnId: ${fnIdStr}, args: __serializeArgs(args), __channelId: ${channelIdStr} }, "*"); };`,
			);
		} else if (stub.guestDeserialize) {
			lines.push(
				`const ${varName} = async (...args) => { const __raw = await __callHost(${fnIdStr}, args); return (${stub.guestDeserialize})(__raw); };`,
			);
		} else {
			lines.push(
				`const ${varName} = async (...args) => __callHost(${fnIdStr}, args);`,
			);
		}
	}
	return lines.join("\n");
}

function generateGlobalsRegistry(stubs: StubDef[]): string {
	const lines = [
		"// Globals registry (passed as Function parameters during exec)",
	];
	lines.push("const __globals = {};");

	if (stubs.length === 0) return lines.join("\n");

	const roots = new Map<string, StubDef[]>();
	for (const stub of stubs) {
		const root = stub.path[0] as string;
		let group = roots.get(root);
		if (!group) {
			group = [];
			roots.set(root, group);
		}
		group.push(stub);
	}

	for (const [root, group] of roots) {
		const topLevel = group.find((s) => s.path.length === 1);
		if (topLevel) {
			lines.push(
				`__globals[${JSON.stringify(root)}] = ${stubVarName(topLevel.fnId)};`,
			);
			continue;
		}

		lines.push(`__globals[${JSON.stringify(root)}] = {};`);

		const created = new Set<string>();
		for (const stub of group) {
			for (let i = 1; i < stub.path.length - 1; i++) {
				const partialPath = stub.path.slice(0, i + 1).join(".");
				if (!created.has(partialPath)) {
					created.add(partialPath);
					const parent = buildAccessor(root, stub.path, i);
					const segment = stub.path[i] as string;
					lines.push(`${parent}[${JSON.stringify(segment)}] = {};`);
				}
			}

			const parentAccessor = buildAccessor(
				root,
				stub.path,
				stub.path.length - 1,
			);
			const leaf = stub.path[stub.path.length - 1] as string;
			lines.push(
				`${parentAccessor}[${JSON.stringify(leaf)}] = ${stubVarName(stub.fnId)};`,
			);
		}
	}

	return lines.join("\n");
}

function generateMessageHandler(
	hasRpcStubs: boolean,
	channelIdStr: string,
): string {
	const hostResponseHandler = hasRpcStubs
		? `
	if (msg.type === "host-response") {
		const p = __pending.get(msg.callId);
		if (p) {
			__pending.delete(msg.callId);
			if (msg.error) {
				p.reject(new Error(msg.error.message));
			} else {
				p.resolve(msg.result);
			}
		}
		return;
	}
`
		: "";

	return `// Message handler
function __stripExports(code) {
	return code.replace(/\\bexport\\s*\\{[^}]*\\}\\s*;?/g, "");
}

async function __execute(code) {
	const module = { exports: {} };
	const paramNames = ["module", "exports"];
	const paramValues = [module, module.exports];
	for (const [name, value] of Object.entries(__globals)) {
		paramNames.push(name);
		paramValues.push(value);
	}
	const __fn = new Function(
		...paramNames,
		"return (async () => {\\n" + __stripExports(code) + "\\n})();"
	);
	await __fn(...paramValues);
}

window.addEventListener("message", async (event) => {
	const msg = event.data;
	if (!msg || msg.__channelId !== ${channelIdStr}) return;
${hostResponseHandler}
	if (msg.type === "callback-invoke") {
		const cb = __callbacks.get(msg.callbackId);
		if (cb) cb.apply(null, msg.args);
		return;
	}
	if (msg.type === "callback-release") {
		__callbacks.delete(msg.callbackId);
		return;
	}
	if (msg.type === "exec") {
		let error;
		try {
			await __execute(msg.code);
		} catch (err) {
			error = {
				message: err instanceof Error ? err.message : String(err),
				name: err instanceof Error ? err.name : "Error",
			};
		}
		window.parent.postMessage({ type: "done", ok: !error, error: error, __channelId: ${channelIdStr} }, "*");
	}
});

// Signal the host that the preamble is ready to receive exec messages.
window.parent.postMessage({ type: "ready", __channelId: ${channelIdStr} }, "*");`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubVarName(fnId: string): string {
	return `__stub_${fnId.replace(/\./g, "_")}`;
}

function buildAccessor(
	root: string,
	path: string[],
	upToIndex: number,
): string {
	let expr = `__globals[${JSON.stringify(root)}]`;
	for (let i = 1; i < upToIndex; i++) {
		expr += `[${JSON.stringify(path[i] as string)}]`;
	}
	return expr;
}
