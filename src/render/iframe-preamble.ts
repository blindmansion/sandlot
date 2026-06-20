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
		generateHandleRegistry(),
		hasRpcStubs ? generatePromiseMap(channelIdStr) : null,
		generateStubs(stubs, channelIdStr),
		generateGlobalsRegistry(stubs),
		generateRegistryRuntime(),
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

function generateHandleRegistry(): string {
	return `// Handle registry: keep non-serializable eval return values in this realm
// and reference them across calls by an opaque token (mirrors __callbacks).
const __handles = new Map();
let __nextHandleId = 0;
const __HANDLE_SENTINEL = "__sandlot_handle__";

function __registerHandle(value) {
	const id = __nextHandleId++;
	__handles.set(id, value);
	return { [__HANDLE_SENTINEL]: id };
}

// Replace handle tokens in eval args with the live objects they reference.
// Only scans the top-level args array (no deep traversal), matching the
// callback hydration contract.
function __hydrateArgs(args) {
	return (args || []).map(function (arg) {
		if (arg !== null && typeof arg === "object" && __HANDLE_SENTINEL in arg) {
			return __handles.get(arg[__HANDLE_SENTINEL]);
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

/**
 * The module-registry runtime: registers per-module factories, resolves
 * `require` (project specifiers → registry, bare specifiers → vendor map), and
 * mounts a {@link RenderPayload}. Replaces the old single-blob `__execute`.
 *
 * Mirrors the reference implementation exercised by `test/render-payload.test.ts`.
 * Host-function globals (`Sand.*`, `console`, …) are injected into every module
 * factory the same way the legacy runtime injected them into the blob.
 */
function generateRegistryRuntime(): string {
	return `// --- Module registry runtime ---
const __globalNames = Object.keys(__globals);
const __globalValues = Object.values(__globals);
const __registry = new Map();
const __cache = new Map();
let __vendor = {};
let __entry = null;

function __requireSync(fromPath, spec) {
	const reg = fromPath != null ? __registry.get(fromPath) : null;
	let key = null;
	if (reg && reg.deps[spec]) key = reg.deps[spec];
	else if (__registry.has(spec)) key = spec;
	if (key == null) {
		if (Object.prototype.hasOwnProperty.call(__vendor, spec)) return __vendor[spec];
		if (/\\.css$/.test(spec)) return {};
		throw new Error("Cannot find module '" + spec + "' from '" + fromPath + "'");
	}
	return __instantiate(key).exports;
}

function __instantiate(key) {
	const cached = __cache.get(key);
	if (cached) return cached;
	const rec = __registry.get(key);
	if (!rec) throw new Error("Module not registered: " + key);
	const module = { exports: {} };
	__cache.set(key, module);
	rec.ret = rec.factory(
		module,
		module.exports,
		function (s) { return __requireSync(key, s); },
		...__globalValues
	);
	return module;
}

function __registerModule(m) {
	// Async modules (import-less entry mount code) may use top-level await, so
	// the body runs inside an async IIFE whose promise the entry mount awaits.
	const body = m.async
		? "return (async () => {\\n" + m.code + "\\n})();"
		: m.code;
	const factory = new Function("module", "exports", "require", ...__globalNames, body);
	__registry.set(m.path, { factory: factory, deps: m.deps || {}, async: !!m.async });
}

async function __runEntry() {
	__instantiate(__entry);
	const rec = __registry.get(__entry);
	if (rec && rec.ret && typeof rec.ret.then === "function") await rec.ret;
}

async function __mount(payload) {
	const __vmod = { exports: {} };
	(new Function("module", "exports", payload.vendor))(__vmod, __vmod.exports);
	__vendor = __vmod.exports || {};
	__entry = payload.entry;
	for (const m of payload.modules) __registerModule(m);
	await __runEntry();
}

// Phase 3 HMR: re-register the changed factories, then re-run the whole graph
// from the entry. There is no accept-boundary walk yet, so we clear the module
// cache (every module re-instantiates with the new factories) and reset the
// mount point for a clean re-render. The iframe realm, window, and CSS survive
// — only in-app JS state resets. Throwing here (missing module, a custom element
// that can't be redefined, …) bubbles up so the host can fall back to a reload.
async function __applyPatch(modules) {
	for (const m of modules) __registerModule(m);
	__cache.clear();
	const __root = document.getElementById("root");
	if (__root) __root.innerHTML = "";
	await __runEntry();
}`;
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

async function __evaluate(code, args) {
	const module = { exports: {} };
	const paramNames = ["module", "exports", "__args"];
	const paramValues = [module, module.exports, __hydrateArgs(args)];
	for (const [name, value] of Object.entries(__globals)) {
		paramNames.push(name);
		paramValues.push(value);
	}
	const __fn = new Function(
		...paramNames,
		"return (async () => {\\n" + __stripExports(code) + "\\n})();"
	);
	return await __fn(...paramValues);
}

window.addEventListener("message", async (event) => {
	const msg = event.data;
	if (!msg || msg.__channelId !== ${channelIdStr}) return;
${hostResponseHandler}
	if (msg.type === "eval") {
		let result, error;
		try {
			result = await __evaluate(msg.code, msg.args || []);
		} catch (err) {
			error = {
				message: err instanceof Error ? err.message : String(err),
				name: err instanceof Error ? err.name : "Error",
				stack: err instanceof Error ? err.stack : undefined,
			};
		}
		if (error) {
			window.parent.postMessage({ type: "eval-result", evalId: msg.evalId, error: error, __channelId: ${channelIdStr} }, "*");
			return;
		}
		if (msg.returnHandle) {
			// Keep the value in this realm; only its token crosses the boundary.
			window.parent.postMessage({ type: "eval-result", evalId: msg.evalId, handle: __registerHandle(result), __channelId: ${channelIdStr} }, "*");
			return;
		}
		try {
			window.parent.postMessage({ type: "eval-result", evalId: msg.evalId, result: result, __channelId: ${channelIdStr} }, "*");
		} catch (postErr) {
			window.parent.postMessage({ type: "eval-result", evalId: msg.evalId, error: { message: "Result is not serializable: " + (postErr instanceof Error ? postErr.message : String(postErr)), name: "DataCloneError" }, __channelId: ${channelIdStr} }, "*");
		}
		return;
	}
	if (msg.type === "handle-release") {
		__handles.delete(msg.handleId);
		return;
	}
	if (msg.type === "css-update") {
		// Hot-swap CSS in place: replace the <style> text, no JS re-execution.
		const __cssEl = document.getElementById("__sandlot_css");
		if (__cssEl) __cssEl.textContent = msg.css;
		return;
	}
	if (msg.type === "hmr-patch") {
		let outcome = "accepted", error;
		try {
			await __applyPatch(msg.modules || []);
		} catch (err) {
			outcome = "full-reload";
			error = {
				message: err instanceof Error ? err.message : String(err),
				name: err instanceof Error ? err.name : "Error",
				stack: err instanceof Error ? err.stack : undefined,
			};
		}
		window.parent.postMessage({ type: "hmr-result", patchId: msg.patchId, outcome: outcome, error: error, __channelId: ${channelIdStr} }, "*");
		return;
	}
	if (msg.type === "callback-invoke") {
		const cb = __callbacks.get(msg.callbackId);
		if (cb) cb.apply(null, msg.args);
		return;
	}
	if (msg.type === "callback-release") {
		__callbacks.delete(msg.callbackId);
		return;
	}
	if (msg.type === "mount") {
		let error;
		try {
			await __mount(msg.payload);
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
