# In-browser Hot Module Replacement

A plan for adding Hot Module Replacement (HMR) to the `render` path so that a
VFS edit updates the live view in place — preserving DOM and component state
where possible — instead of reloading the whole iframe.

This document is self-contained: it describes the current render runtime, the
constraints that shape the design, the target architecture, and a phased
implementation with file-by-file changes.

---

## 1. Goals and non-goals

**Goals**

- A VFS write to a project source file updates the running view without a full
  document reload.
- CSS edits swap instantly with zero JS state loss.
- React component edits preserve hook/component state (via `react-refresh`).
- A clean, always-available fallback: if a change can't be hot-applied, do a
  full remount (today's behavior).
- The registry runtime is *the* render runtime — not a mode. There is no
  caller-facing HMR flag: `render()` always mounts through the registry, and the
  facade pushes patches instead of remounting whenever it can. The headless
  `run()` (Worker) path and the meaning of `bundle()` are untouched only because
  they are genuinely separate concerns, not for compatibility reasons.

> **No backwards-compatibility constraint.** Nothing here preserves an existing
> contract for its own sake. The old single-blob render runtime is deleted (not
> flagged off), the host↔iframe protocol is redesigned rather than extended, and
> result/handle shapes change freely where it buys clarity. Parity with today's
> behavior is proven by tests, not by keeping the old code path alive.

**Non-goals (for now)**

- HMR for `run()` (headless Worker execution has no UI to preserve).
- Preserving state across dependency installs (`install()` already forces a full
  invalidation; a remount there is acceptable).
- A general plugin ecosystem for custom `import.meta.hot` semantics beyond what
  the framework refresh integrations need.

---

## 2. How `render` executes today

Understanding the current runtime is essential, because HMR replaces a specific
piece of it.

### 2.1 Bundle → one string

`render()` drives a persistent bundle session and ships a single bundled string:

```435:454:test/browser/sandbox.ts
	async render(entryPoint, options) {
		const session = await getBundleSession(entryPoint, {
			format: "esm",
			platform: "browser",
			target: "es2022",
		});
		const { code, css } = await session.rebuild();
		const handle = renderFn({
			code,
			css: options?.css ?? css,
			hostFunctions: sandHostFunctions,
		});
```

The session is a long-lived esbuild `BuildContext` with `bundle: true`, so the
output is **one closure blob** with all module boundaries dissolved. The graph
edges esbuild computed are discarded — only the input path list survives:

```242:242:src/toolchain/bundle/core.ts
	const inputs = result.metafile ? Object.keys(result.metafile.inputs) : [];
```

### 2.2 Mount = replace `srcdoc`

The render fn assembles a full HTML document and assigns it to `iframe.srcdoc`,
tearing down any previous render first:

```96:100:src/render/iframe-render.ts
		// Tear down previous render
		if (activeHandle) {
			activeHandle.close();
			activeHandle = null;
		}
```

```53:63:src/render/iframe-render.ts
function assembleHtml(preamble: string, css?: string): string {
	const styleBlock = css ? `<style>${css}</style>` : "";
	return `<!doctype html>
<html>
<head><meta charset="utf-8">${styleBlock}</head>
<body>
<div id="root"></div>
<script>${preamble}</script>
</body>
</html>`;
}
```

So today every rebuild is a **full document reload**: new iframe document, fresh
DOM, all JS state lost.

### 2.3 The runtime is a single `new Function` blob

Inside the iframe, the bundled code is executed as a plain async function body —
`export {}` statements are stripped, and there is no module system at runtime:

```235:248:src/render/iframe-preamble.ts
async function __execute(code) {
	const module = { exports: {} };
	const paramNames = ["module", "exports"];
	const paramValues = [module, module.exports];
	for (const [name, value] of Object.entries(__globals)) {
		paramNames.push(name);
		paramValues.push(value);
	}
	const __fn = new Function(
		...paramNames,
		"return (async () => {\n" + __stripExports(code) + "\n})();"
	);
	await __fn(...paramValues);
}
```

There are **no addressable modules at runtime** — exactly one function scope.
This is the piece HMR has to replace.

### 2.4 There is already a way to push code into the live iframe

The render iframe is sandboxed without `allow-same-origin`, so the parent can't
touch its DOM directly. Everything crosses `postMessage` via the transport
(`src/render/iframe-transport.ts`), and the handle already exposes `evaluate` /
`evaluateHandle`, which inject a code string and run it in the live realm:

```228:248:src/render/iframe-render.ts
		async function sendEval<T = unknown>(
			code: string,
			evalArgs: unknown[],
			returnHandle: boolean,
		): Promise<EvaluateResult<T>> {
			await readyPromise;
			if (closed) {
				return { ok: false, error: { message: "Render closed" } };
			}
			const evalId = nextEvalId++;
			return new Promise<EvaluateResult<T>>((resolve) => {
				pendingEvals.set(evalId, resolve as (r: EvaluateResult) => void);
				transport.send({
					type: "eval",
					evalId,
					code,
					args: evalArgs,
					...(returnHandle ? { returnHandle: true } : {}),
				});
			});
		}
```

**This is the patch-install transport HMR needs — it already exists.** A patch
is just another structured-clone-safe message over the same channel.

---

## 3. Constraints that shape the design

1. **The runtime must be registry-based.** A closure blob has nothing to swap.
   We need per-module factories addressable by path, a runtime `require`, and a
   module cache we control. This replaces §2.3.

2. **Patches must be serializable.** The iframe boundary is `postMessage`-only,
   so a patch is a structured-clone-safe descriptor (`{ path, code, deps }`),
   never a live object. (This is already true of every message in the system, so
   it costs nothing to honor — but it is non-negotiable.)

3. **"Which module changed" cannot be inferred from esbuild.** The bundle
   session re-reads every file on every rebuild — esbuild-wasm can't stat the
   VFS, so the plugin's `onLoad` runs for all inputs each time:

   ```9:13:src/toolchain/bundle/session.ts
    * Module *content* is re-read on every rebuild (the plugin's `onLoad` runs each
    * time, leaving content caching to the filesystem backing), but module
    * *resolution* (stat probes, parsed package.json, bare-import decisions) is
    * cached across rebuilds.
   ```

   Therefore the changed-module set must come from **our own content hashing**,
   keyed by path. The sandbox already knows the exact path on every write, so
   this is cheap and precise.

4. **The build graph must be captured explicitly.** The accept-boundary walk
   needs import edges, which today are thrown away (§2.1). We must surface
   `metafile.inputs[*].imports` from the build.

5. **HMR is render-only and opt-in.** The shared FS plugin
   (`createFileSystemPlugin`) loads modules for `bundle`, `run`, and `render`
   alike; HMR instrumentation must not leak into the others.

---

## 4. Target architecture

```
 VFS write (sandbox.fs.write)
   │  hash + diff → changed paths
   ▼
 Bundle session.rebuild()  ──► graph (metafile.inputs[].imports)
   │
   ├─ per changed module: esbuild.transform → CJS factory  ──► { path, code, deps }
   ▼
 RenderHandle.applyPatch(patches)   (new)
   │  postMessage over existing transport
   ▼
 Iframe registry runtime (new preamble)
   │  re-register factory, invalidate module cache entry
   ▼
 Accept-boundary walk (graph) ─► accepted? re-run boundary : full reload
```

Two runtimes are unified: the **initial mount** and **subsequent patches** both
flow through the registry. There is no separate closure-blob path anymore.

---

## 5. Component 1 — registry runtime (new iframe preamble)

Replace the `__execute` blob (§2.3) with a small CommonJS-style module system.
Note the current exec wrapper already threads `module`/`exports`, so this is a
natural evolution rather than a rewrite of the host-function machinery in
`src/render/iframe-preamble.ts` (the stub/globals/handle/callback generators stay
as-is).

### 5.1 Registry shape

Proposed runtime, injected into the iframe (new code):

```js
// __sandlot module registry (render runtime)
const __registry = new Map();   // path -> { factory, deps }
const __cache = new Map();      // path -> module.exports (instantiated)
const __hot = new Map();        // path -> { accepted, onDispose, data }

function __register(path, factory, deps) {
  __registry.set(path, { factory, deps: deps || {} });
}

function __require(fromPath, spec) {
  // deps maps the *written* specifier to an absolute registry key
  const reg = __registry.get(fromPath);
  const resolved = (reg && reg.deps[spec]) || spec;
  if (__cache.has(resolved)) return __cache.get(resolved);
  const target = __registry.get(resolved);
  if (!target) throw new Error("Module not found: " + spec + " from " + fromPath);
  const module = { exports: {} };
  __cache.set(resolved, module.exports);
  const hot = __makeHot(resolved);
  target.factory(module, module.exports, (s) => __require(resolved, s), hot, ...__globalValues);
  __cache.set(resolved, module.exports); // re-set in case of reassignment
  return module.exports;
}

function __makeHot(path) {
  let entry = __hot.get(path);
  if (!entry) { entry = { accepted: false, onDispose: null, data: {} }; __hot.set(path, entry); }
  return {
    accept(cb) { entry.accepted = true; entry.acceptCb = cb || null; },
    dispose(cb) { entry.onDispose = cb || null; },
    data: entry.data,
  };
}
```

- `factory(module, exports, require, import_meta_hot, ...globals)` — the per-module
  closure produced by the build (§6). `...globals` are the same host-function
  globals the current preamble injects via `__globals` (so `Sand.fs.*`,
  `console`, etc. remain available inside modules).
- `deps` translates the **written** specifier (`"./foo"`, `"react"`) to the
  **absolute registry key** (`"/src/foo.tsx"`, `"/node_modules/react/index.js"`),
  so the runtime `require` stays a dumb registry lookup.

### 5.2 Initial mount via the registry

The `exec` message handler changes from "run one blob" to "register all modules,
then require the entry":

```js
// on { type: "exec", modules: [{path, code, deps}], entry }
for (const m of modules) {
  const factory = new Function(
    "module", "exports", "require", "import_meta_hot", ...__globalNames,
    m.code
  );
  __register(m.path, factory, m.deps);
}
__require(null, entry); // null importer; entry is already an absolute key
```

This keeps a single runtime model for load and patch, and keeps the host
function injection identical to today (the `__globals` registry and stub
generation in `src/render/iframe-preamble.ts` are reused unchanged).

**Vendor vs. project split.** Registering *every* module individually would mean
transforming all of `node_modules` (every React file, etc.) on every cold load —
wasteful, since dependencies only change on `install()`, which forces a full
reload anyway. So the cold mount ships two things:

- a single **vendor blob** — the bundled `node_modules` portion, registered as a
  set of pre-resolved modules (or one opaque chunk the project modules
  `require` into);
- **project modules** registered individually as factories (the hot-swappable
  set).

Only project modules are ever patched. This keeps cold-start as cheap as today's
single bundle while making exactly the files a user edits addressable.

### 5.3 Patch application

A new `hmr-patch` message re-registers changed module factories, clears their
cache entries, and runs the accept-boundary walk (§9):

```js
// on { type: "hmr-patch", patches: [{path, code, deps}], css? }
for (const p of patches) {
  const factory = new Function("module","exports","require","import_meta_hot", ...__globalNames, p.code);
  __register(p.path, factory, p.deps);
}
__applyAcceptWalk(patches.map(p => p.path)); // → "accepted" | "full-reload"
```

---

## 6. Component 2 — registry-format build output

esbuild's `bundle: true` cannot emit a one-factory-per-module registry, so we
compile modules **individually** and assemble the registry payload ourselves.

### 6.1 Add `transform` to the esbuild abstraction

Today the abstraction exposes only `build` and `context`:

```153:163:src/toolchain/bundle/types.ts
export interface EsbuildAPI {
	/** One-shot build: parse, resolve, load, and emit in a single call. */
	build(options: esbuild.BuildOptions): Promise<esbuild.BuildResult>;
	/**
	 * Long-running incremental form. The returned context keeps esbuild's parsed
	 * graph in memory so `rebuild()` only re-does work for changed inputs. Works
	 * with both native esbuild and esbuild-wasm (the `watch`/`serve` methods do
	 * not work in the browser, but `rebuild()` does).
	 */
	context(options: esbuild.BuildOptions): Promise<esbuild.BuildContext>;
}
```

Add:

```ts
	/** Transform a single module's source (no bundling, no resolution). */
	transform(input: string, options: esbuild.TransformOptions): Promise<esbuild.TransformResult>;
```

Implement it in `src/toolchain/bundle/wasm.ts` (`es.transform`) and
`src/toolchain/bundle/native.ts`, mirroring the existing `build`/`context`
wrappers that lazily initialize esbuild-wasm.

### 6.2 Per-module compilation

For each module path, read source from the VFS and transform to CJS:

```ts
const out = await esbuild.transform(source, {
  loader: loaderFromPath(path),   // reuse getLoaderFromPath in bundle/plugin.ts
  format: "cjs",
  target: "es2022",
  jsx: "automatic",
  sourcemap: "inline",
});
```

CJS output references dependencies as `require("<written specifier>")`. We do
**not** rewrite specifiers in the code; instead we ship a `deps` map (§6.3) and
let the runtime `require` translate (§5.1). This keeps transform output verbatim.

### 6.3 The dependency map comes from the build graph

A single `bundle` rebuild still runs (it gives us the authoritative graph and
catches resolution errors). Surface the import edges from the metafile. Extend
`extractResult` (`src/toolchain/bundle/core.ts`) and `BundleResult`
(`src/toolchain/bundle/types.ts`) with a graph:

```ts
// BundleResult addition (required, not optional — every consumer benefits and
// there is no compatibility reason to gate it)
graph: Record<string, { imports: Array<{ original?: string; path: string }> }>;
```

(Separately worth doing while we're free to change shapes: the render path no
longer needs the concatenated `code` string — it consumes `graph` plus
per-module transforms. Consider a dedicated render-build result rather than
overloading `BundleResult.code` for a value render never uses.)

esbuild's `metafile.inputs[path].imports[]` carries both `path` (resolved input
key) and `original` (the specifier as written). That yields, per module, the
`deps` map `{ [original]: path }` for §5.1, and the parent/child edges for the
accept-boundary walk (§9).

### 6.4 Putting it together (patch generation, host side)

New module (e.g. `src/render/hmr.ts` or a method on a render-bundle wrapper):

```ts
async function buildPatch(changedPaths, session, esbuild, fs): Promise<Patch[]> {
  const { graph } = await session.rebuild();           // refresh graph + validate
  const patches = [];
  for (const path of changedPaths) {
    if (!graph[path]) continue;                         // not in the current graph
    const source = await fs.readFile(path);
    const { code } = await esbuild.transform(source, { /* §6.2 */ });
    const deps = Object.fromEntries(
      graph[path].imports
        .filter(i => i.original)
        .map(i => [i.original, i.path]),
    );
    patches.push({ path, code, deps });
  }
  return patches;
}
```

---

## 7. Component 3 — change detection (content hashing)

Because `onLoad` re-fires for everything (§3.3), the changed set is tracked in
the sandbox facade, not derived from esbuild. Today every write already notifies
the bundle sessions:

```338:342:test/browser/sandbox.ts
	async write(path, content) {
		await fs.writeFile(path, content);
		await typecheckSession.changed(path);
		notifyBundleSessions("changed", path);
	},
```

Add a `Map<path, hash>` alongside this. On write, hash the new content; if it
differs from the stored hash, record the path as dirty for the next patch flush.
Structural changes (`rm`, new files, anything matching
`isNodeModulesOrManifest`) and `install()` escalate to a full reload, mirroring
how the bundle session already escalates those to a full cache reset:

```107:113:src/toolchain/bundle/session.ts
	private notify(path: string): void {
		if (isNodeModulesOrManifest(path)) {
			this.resolveCache.markFullReset();
		} else {
			this.resolveCache.markDirty(path);
		}
	}
```

A small debounce (microtask or short timer) coalesces a burst of writes into one
patch flush.

---

## 8. Component 4 — patch protocol and transport

Add render-only message types to `src/run/protocol.ts`, alongside the existing
`ExecMessage` / `EvalMessage`:

```ts
export interface HmrPatchMessage {
  type: "hmr-patch";
  patches: Array<{ path: string; code: string; deps: Record<string, string> }>;
}

// CSS is shipped separately (already implemented in Phase 2) — a CSS swap has
// no patch graph and no reply to correlate, so it rides its own fire-and-forget
// message rather than being folded into hmr-patch:
export interface CssUpdateMessage {
  type: "css-update";
  css: string;             // full <style> text to swap in (§10)
}

export interface HmrResultMessage {
  type: "hmr-result";
  outcome: "accepted" | "full-reload";
  error?: { message: string; name?: string; stack?: string };
}
```

Redesign the mount message directly rather than extending it: replace
`ExecMessage`'s `{ code }` with the registry shape from §5.2 (`vendor`,
`modules[]`, `entry`). There is no transitional `hmr-init` and no second runtime
— `exec` *is* the registry init. Rename it honestly (e.g. `mount`) since it no
longer carries a single code blob.

Host side (`src/render/iframe-render.ts`): add `applyPatch(patches, css?)` to
`RenderHandle` (in `src/render/types.ts`), implemented like `sendEval` —
correlate an `hmr-result` reply, resolve the outcome. No new transport is
needed; reuse `createIframeTransport`.

---

## 9. Component 5 — accept-boundary walk

> **Phase 4 status: ✅ Done.** Implemented as `__acceptWalk` in
> `src/render/iframe-preamble.ts` (mirrored by the Node reference runtime in
> `test/render-payload.test.ts`).

Runs inside the iframe runtime when a patch arrives, using the `deps` edges
captured at registration. esbuild's metafile only gives child edges
(`imports`); the runtime builds the reverse (importers) map on demand from the
registry (`__buildImporters`), so a changed module's import set is always fresh.

`import.meta.hot` is backed by a per-module hot context the build maps to the
`import_meta_hot` factory parameter (a `define` in `compileModule`,
`src/render/payload.ts`). The runtime resets a module's accept/dispose
registrations on every (re-)instantiation and keeps a persistent `data` stash
that survives across instances (dispose writes it, the next instance reads it).

Algorithm (self-accept model):

```
acceptWalk(changedPaths):
  importers = buildImporters()          // reverse graph from registry deps
  affected = {}; boundaries = []; queue = changedPaths; seen = changedPaths
  while queue:
    path = queue.shift(); affected.add(path)
    if hot[path].accepted: boundaries.push(path); continue   // boundary stops here
    imps = importers[path]
    if imps is empty: needsRerun = true; break               // reached a root, nobody accepted
    for imp in imps: if not seen[imp]: queue.push(imp); seen.add(imp)
  if needsRerun: softRerun(); return { mode: "rerun" }
  for path in affected:                                       // capture + invalidate
    if hot[path].onDispose: hot[path].onDispose(hot[path].data)
    delete cache[path]
  for path in boundaries:                                     // re-run only the subgraph
    reinstantiate(path)                                       // lazily re-requires affected deps
    if hot[path].acceptCb: hot[path].acceptCb(exports)
  return { mode: "boundary", boundaries }
```

The walk has **three tiers**, strictly additive over Phase 3:

1. **`boundary`** — a module opted in via `import.meta.hot.accept()`. Only the
   affected subgraph is disposed + re-instantiated; sibling modules keep their
   live instances, so their state is preserved. This is the new Phase 4 win.
2. **`rerun`** — no module accepted the change, so the change propagated to a
   root. Fall back to a same-realm soft re-run (clear cache, reset `#root`,
   re-run the entry): in-app JS state resets, but the document, iframe realm,
   `window`, and CSS survive. This is exactly the Phase 3 behavior.
3. **`full-reload`** — applying the patch *threw* (a now-missing module, a
   custom element that can't be redefined). The error bubbles to the host
   (`hmr-result` `outcome: "full-reload"`), which mounts a fresh render.

So no-opt-in code is never worse off than Phase 3, and code that adds
`import.meta.hot.accept()` graduates to true module-level state preservation.

---

## 10. Component 6 — CSS hot-swap

CSS is the cheapest win and needs no module graph. Today CSS is a `<style>`
block baked into `srcdoc` at mount (§2.2). For hot-swap:

1. Give the style element a stable id in `assembleHtml`
   (`<style id="__sandlot_css">`).
2. On a CSS-only change, send a dedicated `{ type: "css-update", css }` message.
3. The runtime sets `document.getElementById("__sandlot_css").textContent = css`.

Zero JS re-execution, zero state loss.

> **Phase 2 status: ✅ Done.** Shipped as a dedicated `css-update` message
> (`CssUpdateMessage` in `src/run/protocol.ts`) rather than overloading the
> later `hmr-patch` or abusing the `evaluate` channel — a CSS swap has no reply
> to correlate, so it is fire-and-forget. `RenderHandle.applyCss(css)`
> (`src/render/iframe-render.ts`) sends it; the iframe runtime
> (`src/render/iframe-preamble.ts`) replaces the stable `<style>` block's text
> in place. The sandbox facade exposes `updateCss(css?)`
> (`test/browser/sandbox.ts`): with an explicit string it swaps that CSS (and
> remembers it as the override); with no argument it rebuilds the active entry
> and swaps the freshly extracted `bundle.css`. Verified in-browser: editing the
> CSS changed the computed style while a JS-stamped `window` value and DOM
> `data-*` attribute survived unchanged — proving same-realm, no-reload swap.

---

## 11. Component 7 — framework refresh

State preservation across JS edits requires framework-aware refresh runtimes;
don't hand-roll them.

- **React** (`test/fixtures/react-app`, mounts via `createRoot` in
  `src/index.tsx`): integrate `react-refresh`. ✅ **Done** — see the Phase 5
  notes below.
- **Lit / web components** (`test/fixtures/lit-app`, mounts a custom element
  into `#root` in `src/index.ts`): custom elements can't be re-defined under the
  same tag name. Practical v1: accept at the module root and **full-reload** the
  lit fixture, or re-create the element. State preservation for web components is
  a later enhancement; reload is acceptable.

Framework refresh sits on top of the registry + accept-walk; it is additive and
is the last JS-state phase.

### 11.1 React Fast Refresh (as implemented)

Fast Refresh is wired entirely through the existing registry + accept-walk; it is
**opt-in by detection** and a no-op for non-React projects.

- **Detection (`detectReactRefresh`, `src/render/payload.ts`).** Enabled only
  when the project imports React *and* `react-refresh` is installed
  (`/node_modules/react-refresh/package.json` exists). Otherwise the payload
  ships no refresh blob and no module footers — the Phase 4 path is byte-for-byte
  unchanged, so non-React code carries zero risk.
- **Refresh blob (`buildRefreshBlob`).** A separate CJS blob bundles
  `react-refresh/runtime` and calls `injectIntoGlobalHook(window)`, then
  `module.exports` the runtime. It is evaluated **before** the vendor blob in
  `__mount` (`src/render/iframe-preamble.ts`) so React registers its renderer
  through the refresh-aware hook. Because the vendor blob is built with
  `platform: "browser"`, esbuild substitutes `process.env.NODE_ENV =
  "development"`, i.e. React's dev build (Fast Refresh requires it) is already
  what mounts — no extra config.
- **Per-module registration (`reactRefreshFooter`).** Instead of running the
  `react-refresh/babel` transform, each React module gets a small runtime footer
  appended after its esbuild `transform`: it scans `module.exports`, registers
  every export `isLikelyComponentType` finds under a stable family id
  (`"<path> <export>"`), and self-accepts via `import.meta.hot.accept()` iff
  *all* exports are components (matching react-refresh's own boundary rule — a
  module that also exports non-components must propagate so importers re-run).
  This avoids pulling Babel into the browser; the cost is no hook **signatures**,
  so editing a component's hook list isn't auto-detected (a manual reload
  recovers). Editing a component *body* preserves `useState`/`useRef`.
- **Threading (`__react_refresh`).** The runtime hands the refresh instance to
  every factory as the parameter after `import_meta_hot`
  (`(module, exports, require, import_meta_hot, __react_refresh, ...globals)`),
  defaulting to `null`. The footer is the only code that touches it.
- **Swap (`__acceptWalk`).** After the boundary modules re-run (re-registering
  their new component types under the same family ids), the walk calls
  `__refresh.performReactRefresh()` once, which swaps the implementations into
  the live tree while preserving hook state. Modules that don't self-accept
  propagate to an importer boundary (e.g. editing a custom hook re-runs the
  consuming component) or fall back to the Phase 3 soft re-run.

The intrusiveness is contained: the only shared-runtime touch points (the extra
factory parameter, the pre-vendor blob eval, and one `performReactRefresh()`
call) are all null-guarded, so a Lit or vanilla project is unaffected.

---

## 12. Phased delivery

Each phase is independently shippable; the full-reload fallback guarantees
correctness throughout.

1. **Registry runtime + initial mount through the registry.** ✅ **Done.**
   `__execute` is replaced by the registry runtime (§5) and the blob path is
   gone (`__stripExports` survives only for `evaluate`). The render build emits
   `vendor + modules[] + entry` (§6) via `buildRenderPayload`
   (`src/render/payload.ts`); the mount message carries the payload. Parity is
   proven by `test/render-payload.test.ts` (Node, native esbuild + a reference
   runtime) and end-to-end in the browser: multi-module `require` resolution,
   the `lit-app` fixture (vendor blob, decorator lowering, shadow DOM,
   interactivity), the `react-app` fixture (JSX runtime, react-dom, hooks,
   context, events), host-function injection into modules, and a top-level-await
   import-less entry all mount correctly.
2. **CSS hot-swap** (§10). ✅ **Done.** A dedicated `css-update` message and
   `RenderHandle.applyCss` swap the stable `<style>` block's text in place;
   `sandlot.updateCss(css?)` drives it from the facade. Zero JS/DOM state loss,
   verified in-browser.
3. **JS patch + full-reload fallback** (§§6–9, minus accept logic). ✅ **Done.**
   On a JS change the dirty modules are recompiled (`buildRenderPatch`,
   `src/render/payload.ts`) and sent as an `hmr-patch` message; the iframe
   runtime re-registers the factories, clears the module cache, resets `#root`,
   and **re-runs the entry** in place (`__applyPatch` in
   `src/render/iframe-preamble.ts`). The document, iframe realm, `window`, and
   CSS survive; in-app JS state resets (the accept walk that preserves it is
   Phase 4). `RenderHandle.applyPatch` correlates an `hmr-result`
   (`accepted`/`full-reload`); `sandlot.hotUpdate()` drives it, falling back to a
   fresh mount on structural changes (installs, manifest edits, deletions), an
   empty/unresolvable patch set, or any thrown patch. Verified in-browser: a leaf
   edit patched in place (export reflected, `window` state preserved); a manifest
   edit forced a full reload (new document); a syntax error returned `error` with
   the view untouched and re-patched cleanly once fixed.
4. **Accept-boundary walk** (§9). ✅ **Done.** `import.meta.hot.accept()` /
   `.dispose()` / `.data` are backed by a per-module hot context (the build maps
   `import.meta.hot` → the `import_meta_hot` factory param via a `define` in
   `compileModule`, `src/render/payload.ts`). On a patch, `__acceptWalk`
   (`src/render/iframe-preamble.ts`) re-registers the changed factories, builds
   the reverse import graph from the registry, and propagates each change up to
   the nearest accepting module — re-instantiating only that subgraph so sibling
   module/component state survives (`mode: "boundary"`). With no opt-in it falls
   back to the Phase 3 same-realm soft re-run (`mode: "rerun"`); a thrown patch
   still escalates to a host full-reload. The outcome (and which modules re-ran
   as boundaries) is threaded through `HmrResultMessage` → `PatchResult` →
   `sandlot.hotUpdate()`. Covered by `test/render-payload.test.ts` (a self-accept
   boundary preserving a sibling singleton; `dispose`/`data` carrying state
   forward; a no-accept leaf falling back to `rerun`) and the codegen assertions
   in `test/render-preamble.test.ts`.
5. **React refresh** (§11). ✅ **Done.** When the project uses React and
   `react-refresh` is installed, `buildRenderPayload` (`src/render/payload.ts`)
   ships a self-injecting refresh blob (`RenderPayload.refresh`) evaluated before
   the vendor blob, and appends a registration footer to each React module
   (register components by stable family id + self-accept when all exports are
   components). The runtime threads the refresh instance into every factory as
   `__react_refresh`, and `__acceptWalk` (`src/render/iframe-preamble.ts`) calls
   `performReactRefresh()` after a boundary re-runs, so `useState`/`useRef`
   survive a component-body edit. Detection gates everything: non-React projects
   get the exact Phase 4 behavior. Covered by `test/render-payload.test.ts` (a
   component registers under a stable id on mount, then re-registers + refreshes
   on patch with the same family id) and the codegen assertions in
   `test/render-preamble.test.ts`; verified in-browser against `react-app`.
6. **Polish:** error overlay surfaced through the existing `log` channel,
   source-map fidelity, patch debounce tuning, and HMR latency measurement
   (WASM transform cost per edit is the thing to watch).

---

## 13. File-by-file change list

- `src/toolchain/bundle/types.ts` — add `transform` to `EsbuildAPI`; add `graph`
  to `BundleResult`.
- `src/toolchain/bundle/wasm.ts` — implement `transform` (lazy-init like
  `build`/`context`).
- `src/toolchain/bundle/native.ts` — implement `transform` for the native path
  (keeps test parity).
- `src/toolchain/bundle/core.ts` — in `extractResult`, populate `graph` from
  `result.metafile.inputs` (currently only `inputs` keys are kept, line 242).
- `src/render/iframe-preamble.ts` — replace `__execute` (lines 235–248) with the
  registry runtime (§5); add `hmr-patch` handling and the accept-walk; keep the
  stub/globals/handle/callback generators unchanged.
- `src/render/iframe-render.ts` — change the `exec` send (lines 162–169) to the
  registry payload; add `applyPatch` to the handle; add `hmr-result`
  correlation; add a stable CSS `<style id>` in `assembleHtml` (lines 53–63).
- `src/render/types.ts` — add `applyPatch` to `RenderHandle`; add patch types.
- `src/run/protocol.ts` — add `HmrPatchMessage` / `HmrResultMessage`; extend the
  `exec` payload (or add `hmr-init`).
- `src/render/hmr.ts` *(new)* — patch generation (`buildPatch`, §6.4), reverse
  graph construction, react-refresh wrapping.
- `test/browser/sandbox.ts` — add the content-hash map next to `fs.write`
  (lines 338–342); on a debounced dirty flush, call `handle.applyPatch(...)` and
  fall back to re-`render()` on `full-reload`; keep `install()`/structural
  changes escalating to full reload. No HMR flag — patching is the default
  behavior of a live render.
- `docs/` — this document.

---

## 14. Risks and open questions

- **WASM transform latency.** Per-edit cost is a single-module `esbuild.transform`
  plus a `session.rebuild()` for the graph. The rebuild is already incremental;
  the transform is small. Measure early; if the graph rebuild dominates, consider
  deriving edges incrementally instead of a full `rebuild()` per keystroke.
- **CJS interop correctness.** Mixed ESM/CJS dependencies, `__esModule` interop,
  and live-binding semantics differ between esbuild's bundle output and
  per-module CJS transform. The single full `bundle` still runs as the source of
  truth for resolution and error reporting, but runtime behavior of the registry
  path must be validated against both fixtures.
- **Reverse graph freshness.** Adding/removing an import changes edges; treat any
  change to a module's import set as a potential boundary shift and fall back to
  full reload when the importer set changed structurally.
- **Host-function globals in factories.** Modules must receive the same
  `__globals` the blob runtime injects. Confirm the generated stub names line up
  with the factory parameter list (`__globalNames`).
- **Single runtime from the start.** The registry replaces the blob runtime
  outright — there is never a window with two render runtimes to keep in sync.
  The risk this trades into is that Phase 1 must reach mount parity before the
  old path is gone; the mitigation is test-first parity on both fixtures, not a
  compatibility flag.

---

## 15. Testing strategy

- **Runtime parity (Phase 1):** seed `react-app` and `lit-app`, render via the
  registry runtime, assert identical mounted DOM vs. the blob runtime (drive via
  the existing `evaluate` channel / screenshots, as in `test/browser`).
- **CSS swap (Phase 2):** edit a CSS file, assert the `<style>` text changed and
  a known DOM node identity is unchanged (no reload).
- **Patch pipeline (Phase 3):** edit a leaf module, assert the patched export is
  reflected and the document was not reloaded (e.g. a counter set via `evaluate`
  before the edit survives the document but resets on entry re-run — documents
  the Phase 3 limitation).
- **Accept walk (Phase 4):** edit an accepting module; assert only its subgraph
  re-ran (`mode: "boundary"`) and a sibling module's state survived; edit a
  module no one accepts, assert the soft re-run fallback fired (`mode: "rerun"`).
  Covered by `test/render-payload.test.ts`.
- **React refresh (Phase 5):** edit a component body, assert `useState` value
  persists across the edit.
