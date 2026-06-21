# sandlot-4

## Coding agent demo (pi-agent-core + OpenRouter)

A browser-native coding agent wired to the sandlot toolchain. The agent edits an
in-memory TypeScript workspace, typechecks/installs/builds it, and renders a live
preview — all in the page. The agent loop, tool-calling, streaming, and abort
handling come from [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core);
model access is [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)'s
`streamSimple` against OpenRouter.

```bash
echo "OPENROUTER_API_KEY=sk-or-..." > .env   # the dev server reads this
bun run agent                                # serve at http://localhost:4321/agent.html
```

Open `http://localhost:4321/agent.html` and ask it to build or change the app.

How it's wired (`test/browser/agent/`):

- `sandbox-core.ts` — the toolchain (VFS + typecheck/bundle/install/run/render).
- `browser-env.ts` — a pi `ExecutionEnv` (FileSystem + Shell) over that core; every
  method returns a `Result` and never throws.
- `bash.ts` — a deliberately tiny shell: pure string parsing, **no shell features**
  (no pipes/redirection/globs/chaining). Builtins (`ls`, `cat`, `mkdir`, `rm`, …)
  plus toolchain commands (`typecheck`, `install`, `bundle`, `run`, `render`).
- `tools.ts` — model-visible `AgentTool`s: `read`, `write`, `edit`, `ls`, `bash`.
- `app.ts` — assembles the `Agent`, the OpenRouter `streamFn`, and the chat UI.

The OpenRouter key stays server-side: the browser points the model `baseUrl` at the
dev server's `/api/openrouter` proxy (see `serve.ts`), which injects the real key
from `.env`. The browser only ever sends a placeholder key.

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

`eval` evaluates a single expression and auto-awaits a returned promise, so
pass a promise directly (no top-level `await` — it throws a `SyntaxError`) and
project fields with `.then(...)`:

```bash
agent-browser --headed open http://localhost:4321/sandbox.html
agent-browser eval "sandlot.ready()"                                   # warm esbuild-wasm

# Seed files, typecheck, bundle
agent-browser eval "sandlot.fs.seed({'/src/index.ts':'export const x: number = 1'})"
agent-browser eval "sandlot.typecheck().then(r => r.errorCount)"
agent-browser eval "sandlot.bundle('/src/index.ts').then(r => r.inputs)"

# Install a dependency declared in /package.json, then run/render
agent-browser eval "sandlot.fs.write('/package.json', JSON.stringify({name:'demo',dependencies:{'is-number':'^7.0.0'}}))"
agent-browser eval "sandlot.install()"
agent-browser eval "sandlot.run('/src/index.ts')"     # bundle + run in a worker (no DOM)
agent-browser eval "sandlot.render('/src/view.ts')"   # bundle + mount into visible iframe
agent-browser screenshot /tmp/render.png              # visually verify the rendered view

# Inspect or drive the rendered view from the host (runs JS *inside* the iframe)
agent-browser eval "sandlot.evaluate('return document.getElementById(\"root\").innerHTML')"
agent-browser eval "sandlot.evaluate('document.querySelector(\"button\").click(); return true')"

# Hold a reference to a non-serializable value (a DOM node) across calls
agent-browser eval "sandlot.evaluateHandle('return document.querySelector(\"button\")').then(r => r.handle)"
# → { "__sandlot_handle__": 0 }   (the node stays in the iframe; only the token crosses)
agent-browser eval "sandlot.evaluate('__args[0].click(); return __args[0].textContent', {__sandlot_handle__: 0})"
agent-browser eval "sandlot.releaseHandle({__sandlot_handle__: 0})"
```

### `window.sandlot` surface

All methods are async and return only structured-clone-safe data.

- `ready()` — initialize esbuild-wasm (lazy on first build otherwise).
- `fs.read/write/exists/readdir/stat/mkdir/rm/seed/list` — in-memory filesystem. `seed(map)` bulk-writes a `{ path: contents }` map; `list()` returns every path.
- `typecheck()` — `{ errorCount, warningCount, diagnostics[] }` for the current project.
- `bundle(entryPoint, options?)` — `{ code, css?, inputs }` (esbuild-wasm). Defaults to ESM / browser / es2022.
- `install(specs?)` — install packages (defaults to deps declared in `/package.json`); returns `[{ name, version }]`.
- `run(entryPoint)` — bundle and execute in a sandboxed **Web Worker** iframe; returns `{ ok, log, error? }`. There is no DOM here (`document`/`window` are unavailable) — use `render` for anything that touches the DOM.
- `render(entryPoint, options?)` — bundle and mount into the visible iframe, which provides a single `<div id="root">` host element; returns `{ ok, log, error? }`. Entry points should mount their UI into `#root` (e.g. `document.getElementById("root")`).
- `evaluate(code, ...args)` — run JavaScript *inside* the currently-rendered iframe and return its value; `{ ok, value?, error? }`. The code is an async function body that may `return` a value and reference `__args`, runs with the same `Sand.*` host functions, and shares the rendered view's live DOM/`window`. Requires a prior `render(...)`. This is the way to read or mutate the sandboxed iframe's DOM from the host (see the note below). Non-serializable returns (e.g. a DOM node) come back as `{ ok: false }` with a serialization error — use `evaluateHandle` for those.
- `evaluateHandle(code, ...args)` — like `evaluate`, but keeps the top-level return value *inside* the iframe and returns an opaque `handle` token (`{ ok, handle?, error? }`) instead of serializing it. Hold the token and pass it back into later `evaluate`/`evaluateHandle` calls as an arg (it is re-hydrated into the live object), then free it with `releaseHandle`. This is the idiomatic way to reference a DOM node or other non-serializable object across calls.
- `releaseHandle(token)` — release a handle returned by `evaluateHandle`. Handles are also invalidated whenever the render is torn down or replaced (a new `render()`, or `reset()`).
- `fixtures()` — list committed fixtures under `test/fixtures/` (e.g. `lit-app`, `react-app`, `basic`).
- `seedFixture(name, { install? })` — seed a fixture into the in-memory filesystem; pass `{ install: true }` to also install its declared deps. Returns `{ fixture, files, installed? }`.
- `reset()` — clear the in-memory filesystem (including installed packages), reset the typecheck/bundle sessions, and tear down the current render (blanking the iframe and invalidating its handles), to switch tasks without reloading the page.

### Seeding from fixtures

So a session doesn't start from scratch, seed a committed fixture (the real,
editable files under `test/fixtures/`). Either call it explicitly:

```bash
agent-browser eval "sandlot.fixtures()"                       # list options
agent-browser eval "sandlot.seedFixture('lit-app', { install: true })"
agent-browser eval "sandlot.render('/src/index.ts')"
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

- A `render` entry must mount into the iframe's `<div id="root">` (the committed `lit-app` and `react-app` fixtures do this in their `/src/index.ts`). Code that runs but mounts nowhere reports `ok: true` with a blank iframe.
- `run` executes in a Web Worker with no DOM; code that touches `document`/`window` fails there. Use `render` for UI and `run` for headless logic.
- Guest code passed to `run`/`render` can call the bridged `Sand.fs.*` host functions (typed via injected ambient declarations, so `typecheck()` sees them).
- The render/run iframes are sandboxed without `allow-same-origin`, so the parent page cannot read their DOM directly. To inspect or drive a rendered view, use `sandlot.evaluate(...)` (runs JS inside the render iframe and returns serializable values), have rendered code `console.log` what it sees (surfaced in the returned `log`), or verify visually with `agent-browser screenshot`.
- `bundle()` returns the full `code` string; project the field you need (e.g. `sandlot.bundle(...).then(r => r.inputs)`) to keep eval output small.
- For multi-line or heavily-quoted JS, use `agent-browser eval --stdin` with a heredoc.
- `eval` evaluates an expression, so `await` only works inside an async wrapper. Either pass a promise expression directly (`agent-browser eval "sandlot.typecheck()"`) or wrap multiple awaits in an async IIFE (`(async () => { ... })()`).
- Sessions persist across `eval` calls (the browser daemon stays alive), so state accumulates. Use `sandlot.reset()` to start clean, or restart the server. If `agent-browser` reconnects to a stale daemon after a version change, run `agent-browser doctor` / `agent-browser --session default close`.
