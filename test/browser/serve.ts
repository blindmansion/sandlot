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
import { readdir, rm } from "node:fs/promises";
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

// Bun emits content-hashed chunk names and never prunes the outdir, so stale
// chunks (each carrying a full ~10MB TypeScript compiler copy) pile up across
// rebuilds. Wipe the dir first so `dist` only ever holds the current build.
await rm(outdir, { recursive: true, force: true });

const built = await Bun.build({
	entrypoints: [
		join(here, "index.html"),
		join(here, "sandbox.html"),
		join(here, "agent.html"),
	],
	outdir,
	sourcemap: "none",
});

if (!built.success) {
	for (const log of built.logs) console.error(log);
	throw new Error("build failed");
}

const OPENROUTER_PREFIX = "/api/openrouter/";
const OPENROUTER_UPSTREAM = "https://openrouter.ai/api/v1/";

const server = Bun.serve({
	// Pinned (env-overridable) so automation can reliably connect.
	port: Number(process.env.PORT ?? 4321),
	// Provider requests can stream for a long while; don't cut them off.
	idleTimeout: 0,
	async fetch(req) {
		const url = new URL(req.url);

		// Report whether the OpenRouter key is configured, so the agent page can
		// show a helpful hint instead of failing cryptically on first request.
		if (url.pathname === "/api/config") {
			return Response.json({ hasKey: Boolean(process.env.OPENROUTER_API_KEY) });
		}

		// Proxy OpenRouter so the API key stays server-side. The browser points
		// the model's baseUrl at this prefix and sends a placeholder key; we
		// rewrite the Authorization header with the real key from the env.
		if (url.pathname.startsWith(OPENROUTER_PREFIX)) {
			const key = process.env.OPENROUTER_API_KEY;
			if (!key) {
				return Response.json(
					{ error: { message: "OPENROUTER_API_KEY is not set on the dev server (.env)." } },
					{ status: 500 },
				);
			}
			const upstream = `${OPENROUTER_UPSTREAM}${url.pathname.slice(OPENROUTER_PREFIX.length)}${url.search}`;
			const headers = new Headers(req.headers);
			headers.set("authorization", `Bearer ${key}`);
			headers.delete("host");
			const body =
				req.method === "GET" || req.method === "HEAD"
					? undefined
					: await req.arrayBuffer();
			const upstreamRes = await fetch(upstream, {
				method: req.method,
				headers,
				body,
			});
			// Re-stream the (possibly SSE) body; drop hop-by-hop/encoding headers
			// that no longer apply once Bun has decoded the response.
			const outHeaders = new Headers(upstreamRes.headers);
			outHeaders.delete("content-encoding");
			outHeaders.delete("content-length");
			return new Response(upstreamRes.body, {
				status: upstreamRes.status,
				headers: outHeaders,
			});
		}

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
console.log(`sandlot coding agent running at ${server.url}agent.html`);
if (!process.env.OPENROUTER_API_KEY) {
	console.warn(
		"⚠ OPENROUTER_API_KEY is not set — add it to .env for the coding agent (agent.html).",
	);
}
