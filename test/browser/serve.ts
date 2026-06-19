/**
 * Dev server for the sandlot browser smoke test.
 *
 * Bundles `index.html` (which pulls in `app.ts` + `styles.css`, plus the
 * typecheck/bundle/install modules and esbuild-wasm) with `Bun.build`, then
 * serves the static output. We pre-build rather than using Bun's on-the-fly
 * dev server because the bundle is large (TypeScript + esbuild-wasm) and the
 * dev server path is less robust at that size.
 *
 * ```bash
 * bun test/browser/serve.ts
 * ```
 */

import { file, Glob } from "bun";
import { readdir } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const outdir = join(here, "dist");
const fixturesDir = join(here, "..", "fixtures");

/** A fixture name is a single safe path segment (no traversal, no slashes). */
function isSafeFixtureName(name: string): boolean {
	return /^[\w.-]+$/.test(name) && name !== "." && name !== "..";
}

/** List the committed fixture directory names (e.g. `lit-app`, `react-app`). */
async function listFixtures(): Promise<string[]> {
	const entries = await readdir(fixturesDir, { withFileTypes: true });
	return entries
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();
}

/**
 * Read a committed fixture into a `{ "/path": contents }` map so the browser
 * page can seed it into an in-memory filesystem. The page can't read disk, but
 * this server can — so we expose each fixture as a JSON asset.
 */
async function readFixture(name: string): Promise<Record<string, string>> {
	const dir = join(fixturesDir, name);
	const files: Record<string, string> = {};
	const glob = new Glob("**/*");
	for await (const rel of glob.scan({ cwd: dir, onlyFiles: true })) {
		const posix = rel.split(sep).join("/");
		files[`/${posix}`] = await file(join(dir, rel)).text();
	}
	return files;
}

const built = await Bun.build({
	entrypoints: [join(here, "index.html"), join(here, "sandbox.html")],
	outdir,
	sourcemap: "none",
});

if (!built.success) {
	for (const log of built.logs) console.error(log);
	throw new Error("build failed");
}

const server = Bun.serve({
	// Pinned (env-overridable) so automation can reliably connect.
	port: Number(process.env.PORT ?? 4321),
	async fetch(req) {
		const url = new URL(req.url);

		// List available fixtures.
		if (url.pathname === "/fixtures") {
			return Response.json(await listFixtures());
		}

		// Fetch a single fixture as a `{ "/path": contents }` map.
		const fixtureMatch = url.pathname.match(/^\/fixtures\/([^/]+)\.json$/);
		if (fixtureMatch) {
			const name = decodeURIComponent(fixtureMatch[1] as string);
			if (!isSafeFixtureName(name)) {
				return new Response("Bad fixture name", { status: 400 });
			}
			const dirExists = await file(
				join(fixturesDir, name, "package.json"),
			).exists();
			const map = await readFixture(name);
			if (!dirExists && Object.keys(map).length === 0) {
				return new Response("Fixture not found", { status: 404 });
			}
			return Response.json(map);
		}

		// Back-compat alias for the smoke test page (app.ts).
		if (url.pathname === "/lit-fixture.json") {
			return Response.json(await readFixture("lit-app"));
		}

		const path = url.pathname === "/" ? "/index.html" : url.pathname;
		const asset = file(join(outdir, path));
		if (await asset.exists()) return new Response(asset);
		return new Response("Not found", { status: 404 });
	},
});

console.log(`sandlot smoke test running at ${server.url}`);
console.log(`sandlot agent sandbox running at ${server.url}sandbox.html`);
