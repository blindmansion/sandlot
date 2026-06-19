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

import { file } from "bun";
import { dirname, join } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const outdir = join(here, "dist");

const built = await Bun.build({
	entrypoints: [join(here, "index.html")],
	outdir,
	sourcemap: "none",
});

if (!built.success) {
	for (const log of built.logs) console.error(log);
	throw new Error("build failed");
}

const server = Bun.serve({
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname === "/" ? "/index.html" : url.pathname;
		const asset = file(join(outdir, path));
		if (await asset.exists()) return new Response(asset);
		return new Response("Not found", { status: 404 });
	},
});

console.log(`sandlot smoke test running at ${server.url}`);
