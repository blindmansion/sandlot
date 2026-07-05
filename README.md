# sandlot

Experimental browser-native TypeScript toolchain. sandlot runs a dev loop: typecheck, dependency install, bundle, execute, and live render with hot module replacement against an async filesystem interface. There is no server-side build step, container, or disk access.

## Modules

The toolchain is a set of modules (`src/`), each operating over a shared filesystem interface:

- **typecheck** — incremental TypeScript diagnostics via `@typescript/vfs`.
- **install** — resolves and installs npm dependencies into a virtual
`node_modules` (declared in `/package.json`, or explicit specs).
- **bundle** — `esbuild-wasm` bundling.
- **run** — executes a bundle in a sandboxed Web Worker (headless, no DOM).
- **render** — mounts a bundle into a sandboxed iframe with a `#root` host
element. Supports HMR: source and CSS edits patch the live view in place.

Guest code can call bridged `Sand.`* host functions (e.g. `Sand.fs.`*). These are
also surfaced to the typechecker via injected ambient declarations.

## Quickstart

Requires [Bun](https://bun.sh).

```bash
bun install
```

Currently two ways to try it/test it:

### 1. Coding agent demo

A browser-native coding agent (powered by `@earendil-works/pi-agent-core` and
OpenRouter) that edits, builds, and previews an app in the page:

```bash
echo "OPENROUTER_API_KEY=sk-or-..." > .env   # the dev server reads this
bun run agent                                # http://localhost:4321/agent.html
```

Open the page and ask it to build or change an app.

### 2. Drive the sandbox from the host with `agent-browser`

The toolchain is attached to `window.sandlot` on a dev page. A host-side agent
drives it through `agent-browser eval`:

```bash
bun run sandbox                                       # dev server (:4321)
agent-browser --headed open http://localhost:4321/sandbox.html
agent-browser eval "sandlot.ready()"                  # warm esbuild-wasm
agent-browser eval "sandlot.seedFixture('react-app', { install: true })"
agent-browser eval "sandlot.render('/src/index.tsx')"
agent-browser screenshot /tmp/render.png
```

See **[AGENTS.md](./AGENTS.md)** for the full `window.sandlot` surface, the
lifecycle scripts, fixture seeding, and how the agent demo is wired.

## Project layout

```
src/
  toolchain/
    typecheck/   incremental TS diagnostics over the VFS
    install/     npm dependency resolution + virtual node_modules
    bundle/      esbuild-wasm bundling
  run/           host<->guest protocol, guest preamble, generated .d.ts
  runtimes/      execution backends (e.g. iframe Web Worker runner)
  render/        iframe render runtime + HMR (module registry, patching)
  host-functions/ bridged Sand.* host API (fs, console)
test/
  browser/       dev server, agent demo, and window.sandlot sandbox page
  fixtures/      committed sample projects to seed a session
  helpers/       filesystem + harness utilities
docs/            design docs (in-browser HMR, typecheck follow-ups)
```

## Development

```bash
bun run smoke            # end-to-end demo of the toolchain modules
bun test                 # run the test suite
```

## License

[MIT](./LICENSE)