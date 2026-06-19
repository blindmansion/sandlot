/**
 * Node.js built-in modules
 *
 * These are modules that come with Node.js and are not available in the browser
 * without polyfills. When bundling for browser, imports of these modules indicate
 * that the code has Node.js dependencies.
 */

import type { NativeDependency, NativeDependencySummary } from "./types";

/**
 * Complete list of Node.js built-in modules
 * Includes both bare names (e.g., "fs") and prefixed versions (e.g., "node:fs")
 */
export const NODE_BUILTINS = new Set([
	// File System
	"fs",
	"fs/promises",
	"path",

	// Process & OS
	"os",
	"process",
	"child_process",
	"cluster",
	"worker_threads",

	// Networking
	"http",
	"https",
	"http2",
	"net",
	"dgram",
	"dns",
	"dns/promises",
	"tls",

	// Crypto
	"crypto",

	// Streams & Buffers
	"stream",
	"stream/promises",
	"stream/consumers",
	"stream/web",
	"buffer",
	"string_decoder",

	// Utilities
	"util",
	"util/types",
	"events",
	"timers",
	"timers/promises",
	"async_hooks",
	"perf_hooks",
	"trace_events",
	"diagnostics_channel",

	// Console & Debugging
	"console",
	"inspector",
	"inspector/promises",
	"assert",
	"assert/strict",

	// URLs & Query Strings
	"url",
	"querystring",

	// Zlib & Compression
	"zlib",

	// VM & REPL
	"vm",
	"repl",
	"readline",
	"readline/promises",

	// Module System
	"module",

	// TTY & Terminal
	"tty",

	// Other
	"constants",
	"domain", // deprecated
	"punycode", // deprecated
	"v8",
	"wasi",

	// Test runner (Node.js 18+)
	"test",
	"test/reporters",
]);

/**
 * Check if a module specifier is a Node.js built-in
 */
export function isNodeBuiltin(specifier: string): boolean {
	// Handle node: prefix
	const moduleName = specifier.startsWith("node:")
		? specifier.slice(5)
		: specifier;

	return NODE_BUILTINS.has(moduleName);
}

/**
 * Normalize a Node.js built-in module name (remove node: prefix)
 */
export function normalizeBuiltinName(specifier: string): string {
	return specifier.startsWith("node:") ? specifier.slice(5) : specifier;
}

/**
 * Categorize a Node.js built-in module
 */
export type BuiltinCategory =
	| "filesystem"
	| "network"
	| "crypto"
	| "process"
	| "stream"
	| "util"
	| "other";

export function categorizeBuiltin(moduleName: string): BuiltinCategory {
	const name = normalizeBuiltinName(moduleName);

	if (["fs", "fs/promises", "path"].includes(name)) {
		return "filesystem";
	}
	if (
		[
			"http",
			"https",
			"http2",
			"net",
			"dgram",
			"dns",
			"dns/promises",
			"tls",
		].includes(name)
	) {
		return "network";
	}
	if (name === "crypto") {
		return "crypto";
	}
	if (
		["os", "process", "child_process", "cluster", "worker_threads"].includes(
			name,
		)
	) {
		return "process";
	}
	if (
		[
			"stream",
			"stream/promises",
			"stream/consumers",
			"stream/web",
			"buffer",
			"string_decoder",
		].includes(name)
	) {
		return "stream";
	}
	if (
		["util", "util/types", "events", "timers", "timers/promises"].includes(name)
	) {
		return "util";
	}
	return "other";
}

/**
 * Extract package name from a file path.
 * Handles both regular packages (lodash) and scoped packages (@scope/pkg).
 *
 * Walks up the path looking for a "node_modules" segment, then reads the
 * package name from the segment(s) immediately after it.
 */
function extractPackageName(filePath: string): string | null {
	const parts = filePath.split("/");
	const nmIndex = parts.lastIndexOf("node_modules");
	if (nmIndex === -1 || nmIndex + 1 >= parts.length) return null;

	const next = parts[nmIndex + 1] as string;
	// Scoped package: @scope/pkg
	if (next.startsWith("@") && nmIndex + 2 < parts.length) {
		return `${next}/${parts[nmIndex + 2] as string}`;
	}
	return next;
}

/**
 * Build a NativeDependencySummary from tracked imports
 */
export function buildNativeDependencySummary(
	imports: Map<string, Set<string>>,
): NativeDependencySummary {
	const details: NativeDependency[] = [];
	const byCategory: Partial<Record<BuiltinCategory, string[]>> = {};

	for (const [module, importers] of imports) {
		const category = categorizeBuiltin(module);
		const importedBy = Array.from(importers);

		// Extract package names from importer paths
		const packages = new Set<string>();
		for (const importer of importedBy) {
			const pkg = extractPackageName(importer);
			if (pkg) {
				packages.add(pkg);
			} else if (importer === "entry" || !importer.includes("node_modules")) {
				packages.add("(user code)");
			}
		}

		details.push({
			module,
			category,
			importedBy,
			packages: Array.from(packages),
		});

		// Group by category
		byCategory[category] ??= [];
		byCategory[category].push(module);
	}

	// Sort details by module name
	details.sort((a, b) => a.module.localeCompare(b.module));

	return {
		count: imports.size,
		modules: Array.from(imports.keys()).sort(),
		byCategory,
		details,
	};
}
