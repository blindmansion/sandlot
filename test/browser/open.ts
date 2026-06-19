/**
 * Convenience launcher: open the agent sandbox in a visible (headed) browser
 * via the `agent-browser` CLI.
 *
 * ```bash
 * bun run sandbox:open                          # open the bare sandbox
 * FIXTURE=react-app bun run sandbox:open        # auto-seed a fixture
 * FIXTURE=lit-app INSTALL=1 bun run sandbox:open # auto-seed + install deps
 * PORT=5000 bun run sandbox:open                # match a non-default server port
 * ```
 *
 * Requires the dev server (`bun run sandbox`) to be running and the
 * `agent-browser` CLI to be installed.
 */

import { $ } from "bun";

const port = process.env.PORT ?? "4321";
const fixture = process.env.FIXTURE;
const install = process.env.INSTALL === "1" || process.env.INSTALL === "true";

const params = new URLSearchParams();
if (fixture) {
	params.set("fixture", fixture);
	if (install) params.set("install", "1");
}
const query = params.toString();
const url = `http://localhost:${port}/sandbox.html${query ? `?${query}` : ""}`;

console.log(`Opening ${url}`);
await $`agent-browser --headed open ${url}`;
