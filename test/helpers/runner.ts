/**
 * Test harness for executing bundled code produced by the bundle module.
 *
 * Two execution strategies are provided, matching the two bundle formats you'd
 * typically test:
 *
 * - {@link runBundle} runs a **CommonJS** bundle (`format: "cjs"`) synchronously
 *   via `new Function`, injecting a `module`/`exports`/`require`/`console`
 *   sandbox so the code's exports and console output can be captured.
 * - {@link importBundle} runs an **ESM** bundle (`format: "esm"`, the bundler's
 *   default) by dynamically `import()`-ing it as a `data:` URL and returning the
 *   module namespace.
 *
 * Both capture `console` output into a structured log. Neither attempts to be a
 * real security sandbox — they're for exercising trusted, test-authored code.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { format } from "node:util";

/** A single captured console call. */
export interface ConsoleEntry {
	level: "log" | "info" | "warn" | "error" | "debug";
	/** Raw arguments passed to the console method. */
	args: unknown[];
	/** `util.format`-rendered text, as it would appear in a terminal. */
	text: string;
}

/** Result of executing a bundle. */
export interface RunResult<T = unknown> {
	/** The module's exports (`module.exports` for CJS, the namespace for ESM). */
	exports: T;
	/** Captured console output, in call order. */
	logs: ConsoleEntry[];
}

export interface RunOptions {
	/** Extra global bindings to expose to the code (e.g. fetch stubs). */
	globals?: Record<string, unknown>;
	/** Capture `console.*` output. Defaults to `true`. */
	captureConsole?: boolean;
}

export interface RunCjsOptions extends RunOptions {
	/** Resolver for `require(...)` calls. Throws by default. */
	require?: (id: string) => unknown;
}

const CONSOLE_LEVELS: ConsoleEntry["level"][] = [
	"log",
	"info",
	"warn",
	"error",
	"debug",
];

/**
 * Build a console-like object that records calls into `logs` while delegating
 * any non-captured methods to the real console.
 */
function createCapturingConsole(logs: ConsoleEntry[]): Console {
	const capturing: Partial<Console> = {};
	for (const level of CONSOLE_LEVELS) {
		capturing[level] = (...args: unknown[]) => {
			logs.push({ level, args, text: format(...args) });
		};
	}
	return new Proxy(console, {
		get(target, prop, receiver) {
			if (prop in capturing) {
				return capturing[prop as keyof Console];
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}

function defaultRequire(id: string): never {
	throw new Error(
		`require("${id}") is not available in the bundle runner. ` +
			`Pass a custom \`require\` via run options, or bundle the dependency in.`,
	);
}

/**
 * Execute a CommonJS bundle and return its exports plus captured console output.
 *
 * The code runs inside a `new Function` wrapper whose parameters shadow the
 * matching globals, so `module`, `exports`, `require` and (when capturing)
 * `console` are the sandboxed versions. Other globals fall through to the host.
 *
 * @example
 * ```ts
 * const { code } = await bundle({ ..., options: { format: "cjs" } });
 * const { exports, logs } = runBundle<{ main(): string }>(code);
 * expect(exports.main()).toBe("Hello, world!");
 * ```
 */
export function runBundle<T = unknown>(
	code: string,
	options: RunCjsOptions = {},
): RunResult<T> {
	const logs: ConsoleEntry[] = [];
	const sandboxConsole =
		options.captureConsole === false ? console : createCapturingConsole(logs);
	const module: { exports: T } = { exports: {} as T };
	const requireFn = options.require ?? defaultRequire;
	const extraGlobals = options.globals ?? {};

	const extraNames = Object.keys(extraGlobals);
	const paramNames = [
		"module",
		"exports",
		"require",
		"console",
		...extraNames,
	];
	const body = `"use strict";\n${code}\n;return module.exports;`;

	// biome-ignore lint/security/noGlobalEval: intentional code execution harness
	const fn = new Function(...paramNames, body) as (
		...args: unknown[]
	) => T;

	const returned = fn(
		module,
		module.exports,
		requireFn,
		sandboxConsole,
		...extraNames.map((name) => extraGlobals[name]),
	);

	// esbuild's CJS output assigns to `module.exports`; fall back to the wrapper
	// return value just in case the body produced a value directly.
	const exports = (module.exports ?? returned) as T;
	return { exports, logs };
}

/**
 * Execute an ESM bundle by writing it to a temp `.mjs` file and dynamically
 * importing it, returning the module namespace and captured console output.
 *
 * A temp file (rather than a `data:` URL) is used because Bun rejects long
 * `data:` URLs, and bundles with inline source maps get large fast. The unique
 * filename also avoids the module cache across runs. Console capture is achieved
 * by prepending a module-scoped `const console` that shadows the global within
 * the bundle — reassigning `globalThis.console` alone is unreliable in Bun.
 * Extra globals are injected onto `globalThis` for the duration of evaluation
 * (undeclared identifiers in an ES module resolve against the global object).
 *
 * @example
 * ```ts
 * const { code } = await bundle({ ... }); // default format: "esm"
 * const { exports, logs } = await importBundle<{ main(): string }>(code);
 * expect(exports.main()).toBe("Hello, world!");
 * ```
 */
export async function importBundle<T = unknown>(
	code: string,
	options: RunOptions = {},
): Promise<RunResult<T>> {
	const logs: ConsoleEntry[] = [];
	const capture = options.captureConsole !== false;

	const extraGlobals = options.globals ?? {};
	const savedGlobals = new Map<string, { had: boolean; value: unknown }>();
	const host = globalThis as Record<string, unknown>;

	const nonce = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
	const consoleKey = `__sandboxConsole_${nonce}`;

	if (capture) {
		host[consoleKey] = createCapturingConsole(logs);
	}
	for (const [name, value] of Object.entries(extraGlobals)) {
		savedGlobals.set(name, { had: name in host, value: host[name] });
		host[name] = value;
	}

	const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "sandlot-run-"));
	const file = nodePath.join(dir, `bundle-${nonce}.mjs`);
	try {
		// A module-scoped `console` shadows the global one for every reference in
		// the bundle, including inside nested functions.
		const prelude = capture
			? `const console = globalThis[${JSON.stringify(consoleKey)}];\n`
			: "";
		await fs.writeFile(file, `${prelude}${code}`);
		const namespace = await import(/* @vite-ignore */ pathToFileURL(file).href);
		return { exports: namespace as T, logs };
	} finally {
		if (capture) {
			delete host[consoleKey];
		}
		for (const [name, saved] of savedGlobals) {
			if (saved.had) {
				host[name] = saved.value;
			} else {
				delete host[name];
			}
		}
		await fs.rm(dir, { recursive: true, force: true });
	}
}
