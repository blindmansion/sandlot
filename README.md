# sandlot-4

## Driving the sandbox with agent-browser

The sandlot toolchain (fs, typecheck, bundle, install, run, render) can be
driven from a real browser by a host-side coding agent, with no per-action
message protocol. The dev server exposes a page that attaches the whole
toolchain to `window.sandlot`; the agent's only primitive is
`agent-browser eval`, which runs JavaScript in the page's main world, awaits
promises, and returns JSON-serializable values. The browser persists across
calls, so the in-memory filesystem and toolchain state survive between evals.

Start the server (pinned to port 4321, override with `PORT`):

```bash
bun run sandbox
```

Lifecycle scripts:

```bash
bun run sandbox                                  # start the dev server (:4321)
bun run sandbox:open                             # open the sandbox in a visible browser
FIXTURE=react-app bun run sandbox:open           # ...auto-seeding a fixture
FIXTURE=lit-app INSTALL=1 bun run sandbox:open   # ...auto-seeding + installing deps
bun run sandbox:close                            # close the browser session
```

Then drive the sandbox from the host shell. Use `--headed` so the browser
window is visible and you can watch renders happen (omit it for headless/CI):

```bash
agent-browser --headed open http://localhost:4321/sandbox.html
agent-browser eval "await sandlot.ready()"                                   # warm esbuild-wasm

# Seed files, typecheck, bundle
agent-browser eval "await sandlot.fs.seed({'/src/index.ts':'export const x: number = 1'})"
agent-browser eval "(await sandlot.typecheck()).errorCount"
agent-browser eval "(await sandlot.bundle('/src/index.ts')).inputs"

# Install a dependency declared in /package.json, then run/render
agent-browser eval "await sandlot.fs.write('/package.json', JSON.stringify({name:'demo',dependencies:{'is-number':'^7.0.0'}}))"
agent-browser eval "await sandlot.install()"
agent-browser eval "await sandlot.run('/src/index.ts')"     # bundle + run in a worker iframe
agent-browser eval "await sandlot.render('/src/view.ts')"   # bundle + mount into visible iframe
agent-browser screenshot /tmp/render.png                    # visually verify the rendered view
```

### `window.sandlot` surface

All methods are async and return only structured-clone-safe data.

- `ready()` — initialize esbuild-wasm (lazy on first build otherwise).
- `fs.read/write/exists/readdir/stat/mkdir/rm/seed/list` — in-memory filesystem. `seed(map)` bulk-writes a `{ path: contents }` map; `list()` returns every path.
- `typecheck()` — `{ errorCount, warningCount, diagnostics[] }` for the current project.
- `bundle(entryPoint, options?)` — `{ code, css?, inputs }` (esbuild-wasm). Defaults to ESM / browser / es2022.
- `install(specs?)` — install packages (defaults to deps declared in `/package.json`); returns `[{ name, version }]`.
- `run(entryPoint)` — bundle and execute in a sandboxed worker iframe; returns `{ ok, log, error? }`.
- `render(entryPoint, options?)` — bundle and mount into the visible iframe; returns `{ ok, log, error? }`.
- `fixtures()` — list committed fixtures under `test/fixtures/` (e.g. `lit-app`, `react-app`, `basic`).
- `seedFixture(name, { install? })` — seed a fixture into the in-memory filesystem; pass `{ install: true }` to also install its declared deps. Returns `{ fixture, files, installed? }`.
- `reset()` — clear the in-memory filesystem (including installed packages) and reset the typecheck session, to switch tasks without reloading the page.

### Seeding from fixtures

So a session doesn't start from scratch, seed a committed fixture (the real,
editable files under `test/fixtures/`). Either call it explicitly:

```bash
agent-browser eval "await sandlot.fixtures()"                       # list options
agent-browser eval "await sandlot.seedFixture('lit-app', { install: true })"
agent-browser eval "await sandlot.render('/src/index.ts')"
```

…or auto-seed at page load with a query param, so opening the page already has
the code loaded:

```bash
# seed files only
agent-browser --headed open "http://localhost:4321/sandbox.html?fixture=react-app"
# seed files AND install declared deps
agent-browser --headed open "http://localhost:4321/sandbox.html?fixture=lit-app&install=1"
```

Notes:

- Guest code passed to `run`/`render` can call the bridged `Sand.fs.*` host functions (typed via injected ambient declarations, so `typecheck()` sees them).
- The render/run iframes are sandboxed without `allow-same-origin`, so the parent page cannot read their DOM. Have rendered code `console.log` what it sees (surfaced in the returned `log`), or verify visually with `agent-browser screenshot`.
- `bundle()` returns the full `code` string; project the field you need (e.g. `(await sandlot.bundle(...)).inputs`) to keep eval output small.
- For multi-line or heavily-quoted JS, use `agent-browser eval --stdin` with a heredoc.
- `eval` evaluates an expression, so `await` only works inside an async wrapper. Either pass a promise expression directly (`agent-browser eval "sandlot.typecheck()"`) or wrap multiple awaits in an async IIFE (`(async () => { ... })()`).
- Sessions persist across `eval` calls (the browser daemon stays alive), so state accumulates. Use `await sandlot.reset()` to start clean, or restart the server. If `agent-browser` reconnects to a stale daemon after a version change, run `agent-browser doctor` / `agent-browser --session default close`.
