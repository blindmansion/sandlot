/**
 * Generate ambient TypeScript declarations from host function definitions.
 *
 * Builds a `.d.ts` file string that declares all host functions with their
 * type signatures in the global scope. The typechecker picks this up
 * automatically when it's written to the virtual filesystem.
 */

import type { HostFunction } from "./types";

/**
 * A node in the namespace tree. Leaves hold a function signature string;
 * branches hold child nodes keyed by name.
 */
interface NamespaceNode {
	/** Child namespaces / functions */
	children: Map<string, NamespaceNode>;
	/** If this node is a leaf, the callable type signature (e.g. "(x: number) => string") */
	signature?: string;
}

function createNode(): NamespaceNode {
	return { children: new Map() };
}

/**
 * Parse a callable signature like `(path: string) => string` into
 * a parameter list and return type suitable for a `function` declaration.
 *
 * Returns `{ params: "path: string", returnType: "string" }`.
 * Falls back to wrapping the whole thing as a type alias if it can't parse.
 */
function parseSignature(sig: string): { params: string; returnType: string } {
	// Match `(...)  => ...`
	const match = sig.match(/^\s*\((.*)\)\s*=>\s*([\s\S]+)$/);
	if (match) {
		return {
			params: match[1]?.trim() ?? "",
			returnType: match[2]?.trim() ?? "",
		};
	}
	// Can't parse — use the raw string as a type and declare as a const
	return { params: "", returnType: sig };
}

/**
 * Emit a namespace node as declaration lines.
 *
 * @param name - The name of this node
 * @param node - The namespace node to emit
 * @param indent - Current indentation string
 * @param topLevel - Whether this is a top-level (declare) node
 * @param wrapAsync - Whether to wrap return types in Promise<T>
 */
function emitNode(
	name: string,
	node: NamespaceNode,
	indent: string,
	topLevel: boolean,
	wrapAsync: boolean,
): string[] {
	const lines: string[] = [];
	const prefix = topLevel ? "declare " : "";

	if (node.signature !== undefined && node.children.size === 0) {
		// Leaf node — emit as a function declaration
		const { params, returnType } = parseSignature(node.signature);
		const finalReturn =
			wrapAsync && !isPromiseType(returnType)
				? `Promise<${returnType}>`
				: returnType;
		lines.push(
			`${indent}${prefix}function ${name}(${params}): ${finalReturn};`,
		);
	} else if (node.children.size > 0) {
		// Branch node — emit as a namespace
		lines.push(`${indent}${prefix}namespace ${name} {`);
		for (const [childName, childNode] of node.children) {
			lines.push(
				...emitNode(childName, childNode, `${indent}\t`, false, wrapAsync),
			);
		}
		lines.push(`${indent}}`);
	}

	return lines;
}

/**
 * Check whether a return type string already looks like `Promise<...>`.
 */
function isPromiseType(returnType: string): boolean {
	return /^\s*Promise\s*</.test(returnType);
}

export interface GenerateDtsOptions {
	/**
	 * When true, return types that are not already `Promise<T>` are
	 * automatically wrapped in `Promise<T>`. Use this for cross-boundary
	 * runners where all host function calls are async from the guest's
	 * perspective.
	 *
	 * @default false
	 */
	async?: boolean;
}

/**
 * Generate ambient TypeScript declaration file content from host functions.
 *
 * Groups functions by their root path segment, building nested namespaces
 * as needed. Only functions with a `dts` field are included.
 *
 * @returns The `.d.ts` file content, or an empty string if no functions have types.
 */
export function generateHostFunctionDts(
	hostFunctions: HostFunction[],
	options?: GenerateDtsOptions,
): string {
	const wrapAsync = options?.async ?? false;

	// Filter to only functions with type info
	const typed = hostFunctions.filter((hf) => hf.path.length > 0);
	if (typed.length === 0) return "";

	// Build the namespace tree
	const root = createNode();

	for (const hf of typed) {
		let current = root;
		// Walk to the parent, creating intermediate nodes
		for (let i = 0; i < hf.path.length - 1; i++) {
			const segment = hf.path[i] as string;
			if (!current.children.has(segment)) {
				current.children.set(segment, createNode());
			}
			current = current.children.get(segment) as NamespaceNode;
		}
		// Set the leaf
		const leaf = hf.path[hf.path.length - 1] as string;
		if (!current.children.has(leaf)) {
			current.children.set(leaf, createNode());
		}
		const leafNode = current.children.get(leaf) as NamespaceNode;
		leafNode.signature = hf.dts;
	}

	// Emit declarations
	const lines: string[] = [];
	for (const [name, node] of root.children) {
		lines.push(...emitNode(name, node, "", true, wrapAsync));
	}

	return `${lines.join("\n")}\n`;
}
