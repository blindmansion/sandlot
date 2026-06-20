/**
 * Generate the JavaScript preamble injected into the guest worker.
 *
 * The preamble sets up:
 * 1. A promise map for tracking pending host function calls
 * 2. A message listener that resolves/rejects pending calls
 * 3. Async stub functions for each host function (send RPC, return Promise)
 * 4. Nested namespace objects assembled from function paths
 * 5. A console override that sends output back to the host
 * 6. An `exec` message handler that runs the bundled code in an async IIFE
 *
 * All host function stubs and namespace objects are collected into a
 * `__globals` registry. The exec handler passes these as named parameters
 * to an `async function` expression evaluated via (indirect) `eval` with a
 * `//# sourceURL`, so bundled code can use top-level `await`, reference host
 * globals directly, and surface a named frame in stack traces / DevTools.
 *
 * The generated code is plain JavaScript (no TypeScript) suitable for
 * execution inside a Worker via `blob:` URL.
 */

import type { HostFunction } from "./types";

/**
 * Describes a host function stub for guest-side codegen.
 * Only the info needed on the guest side — the actual `fn` stays on the host.
 */
interface StubDef {
	/** Dot-joined path, e.g. "Sand.fs.readFile" */
	fnId: string;
	/** Path segments, e.g. ["Sand", "fs", "readFile"] */
	path: string[];
	/** Optional JS code string for a function that transforms the raw result. */
	guestDeserialize?: string;
	/** When true, the stub sends postMessage without waiting for a response. */
	fireAndForget?: boolean;
}

/**
 * Generate the full worker preamble as a JavaScript string.
 *
 * The resulting code is designed to run inside a Worker where `self` is
 * the global scope with `postMessage` and `onmessage` available.
 */
export function generateGuestPreamble(hostFunctions: HostFunction[]): string {
	const stubs: StubDef[] = hostFunctions
		.filter((hf) => hf.path.length > 0)
		.map((hf) => ({
			fnId: hf.path.join("."),
			path: hf.path,
			guestDeserialize: hf.guestDeserialize,
			fireAndForget: hf.fireAndForget,
		}));

	const hasRpcStubs = stubs.some((s) => !s.fireAndForget);

	return [
		generateHeader(),
		generateCallbackRegistry(),
		hasRpcStubs ? generatePromiseMap() : null,
		generateStubs(stubs),
		generateGlobalsRegistry(stubs),
		generateMessageHandler(hasRpcStubs),
	]
		.filter(Boolean)
		.join("\n\n");
}

// ---------------------------------------------------------------------------
// Code generators (each returns a plain JS code string)
// ---------------------------------------------------------------------------

function generateHeader(): string {
	return `// --- Guest preamble (generated) ---
"use strict";`;
}

function generateCallbackRegistry(): string {
	return `// Callback registry for host-invoked callbacks
const __callbacks = new Map();
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

function generatePromiseMap(): string {
	return `// Promise map for pending host function calls
const __pending = new Map();
let __nextId = 0;

function __callHost(fnId, args) {
	const callId = __nextId++;
	const serializedArgs = __serializeArgs(args);
	return new Promise((resolve, reject) => {
		__pending.set(callId, { resolve, reject });
		postMessage({ type: "host-call", callId, fnId, args: serializedArgs });
	});
}`;
}

/**
 * Generate one stub per host function.
 *
 * RPC stubs (default) call `__callHost(fnId, args)` and return a promise.
 * Fire-and-forget stubs send `postMessage` directly and return void.
 */
function generateStubs(stubs: StubDef[]): string {
	if (stubs.length === 0) return "// (no host function stubs)";

	const lines = ["// Host function stubs"];
	for (const stub of stubs) {
		const varName = stubVarName(stub.fnId);
		const fnIdStr = JSON.stringify(stub.fnId);

		if (stub.fireAndForget) {
			lines.push(
				`const ${varName} = (...args) => { postMessage({ type: "host-call", callId: -1, fnId: ${fnIdStr}, args: __serializeArgs(args) }); };`,
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

/**
 * Build the `__globals` registry object containing top-level names
 * mapped to their values (stub functions or namespace objects).
 *
 * This is the codegen equivalent of `buildGlobals()` in native.ts —
 * it emits source code instead of runtime objects.
 *
 * The exec handler iterates `__globals` to build the parameter list
 * for the inner `new Function()` call.
 */
function generateGlobalsRegistry(stubs: StubDef[]): string {
	const lines = [
		"// Globals registry (passed as Function parameters during exec)",
	];
	lines.push("const __globals = {};");

	if (stubs.length === 0) return lines.join("\n");

	// Group by root segment
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
		// Single-segment path: top-level function
		const topLevel = group.find((s) => s.path.length === 1);
		if (topLevel) {
			lines.push(
				`__globals[${JSON.stringify(root)}] = ${stubVarName(topLevel.fnId)};`,
			);
			continue;
		}

		// Multi-segment: build a namespace object
		lines.push(`__globals[${JSON.stringify(root)}] = {};`);

		const created = new Set<string>();
		for (const stub of group) {
			// Create intermediate objects
			for (let i = 1; i < stub.path.length - 1; i++) {
				const partialPath = stub.path.slice(0, i + 1).join(".");
				if (!created.has(partialPath)) {
					created.add(partialPath);
					const parent = buildAccessor(root, stub.path, i);
					const segment = stub.path[i] as string;
					lines.push(`${parent}[${JSON.stringify(segment)}] = {};`);
				}
			}

			// Assign the leaf stub
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
 * The message handler that listens for `exec` and `host-response` messages.
 *
 * @param hasRpcStubs — whether any RPC (non-fire-and-forget) stubs exist.
 *   When false, the host-response handler is omitted (no pending promises).
 */
function generateMessageHandler(hasRpcStubs: boolean): string {
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
	// Evaluate as a named function expression via (indirect) eval rather than
	// new Function, appending //# sourceURL so the worker frame is attributed to
	// sandlot://run.js in DevTools and stack traces instead of an anonymous blob.
	// The bundle's own inline source-map comment (if any) is dropped: under this
	// wrapper its line mappings are offset and would point at the wrong source.
	// Aligned worker source maps are a later phase.
	const __body = __stripExports(code).replace(/\\n?\\/\\/# sourceMappingURL=[^\\n]*/g, "");
	const __src = "(async function (" + paramNames.join(",") + ") {\\n" + __body + "\\n})\\n//# sourceURL=sandlot://run.js";
	const __fn = (0, eval)(__src);
	await __fn(...paramValues);
}

self.onmessage = async (event) => {
	const msg = event.data;
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
				stack: err instanceof Error ? err.stack : undefined,
			};
		}
		postMessage({ type: "done", ok: !error, error: error });
	}
};`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a dot-joined fnId into a safe variable name. */
function stubVarName(fnId: string): string {
	return `__stub_${fnId.replace(/\./g, "_")}`;
}

/**
 * Build a property-access expression for __globals["root"]... up to
 * (but not including) the segment at `upToIndex`.
 *
 * e.g. for path ["Sand", "fs", "readFile"] and upToIndex=2:
 *   __globals["Sand"]["fs"]
 */
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
