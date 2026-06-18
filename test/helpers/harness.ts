/**
 * Test harness for loading directories of source code through the unified
 * Node-backed filesystem ({@link NodeUnionFs}).
 *
 * A "fixture" is a directory of real files under `test/fixtures/<name>`. Loading
 * a fixture copies it into a fresh OS temp directory so tests can mutate it
 * freely (install packages, write bundles, etc.) without touching the committed
 * fixture. The temp directory becomes the virtual root (`/`) of the returned
 * filesystem.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { NodeUnionFs } from "./node-fs";

/** Absolute path to the committed fixtures directory. */
export const FIXTURES_DIR = nodePath.join(import.meta.dir, "..", "fixtures");

/** A loaded, isolated workspace backed by a real temp directory. */
export interface Workspace {
	/** Unified filesystem rooted at {@link Workspace.root}. */
	fs: NodeUnionFs;
	/** Absolute real path of the temp directory backing the virtual root. */
	root: string;
	/** Remove the temp directory. Safe to call more than once. */
	cleanup(): Promise<void>;
}

function tempPrefix(label: string): string {
	const safe = label.replace(/[^a-zA-Z0-9_-]+/g, "-");
	return nodePath.join(os.tmpdir(), `sandlot-${safe}-`);
}

async function makeWorkspace(root: string): Promise<Workspace> {
	let cleaned = false;
	return {
		fs: new NodeUnionFs(root),
		root,
		async cleanup() {
			if (cleaned) return;
			cleaned = true;
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

/**
 * Copy the named fixture into a fresh temp directory and return a workspace
 * rooted there.
 *
 * @param name Fixture directory name under `test/fixtures/`.
 */
export async function loadFixture(name: string): Promise<Workspace> {
	const source = nodePath.join(FIXTURES_DIR, name);
	try {
		const stat = await fs.stat(source);
		if (!stat.isDirectory()) {
			throw new Error(`Fixture "${name}" is not a directory: ${source}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`Fixture "${name}" not found at ${source}`);
		}
		throw error;
	}

	const root = await fs.mkdtemp(tempPrefix(name));
	await fs.cp(source, root, { recursive: true });
	return makeWorkspace(root);
}

/**
 * Create an empty workspace rooted at a fresh temp directory. Useful for tests
 * that build up their own file tree rather than loading a committed fixture.
 *
 * @param label Optional label used in the temp directory name.
 */
export async function createWorkspace(label = "workspace"): Promise<Workspace> {
	const root = await fs.mkdtemp(tempPrefix(label));
	return makeWorkspace(root);
}
