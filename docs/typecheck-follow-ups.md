# Typecheck: potential follow-ups

The persistent, incremental `TypecheckSession` (see `src/typecheck/session.ts`)
already removed the dominant cost. On the profiling fixture (small project, large
dependencies: `lodash` + `@types/lodash`, `rxjs`, `zod`):

| Scenario        | One-shot  | Persistent | Speedup |
| --------------- | --------- | ---------- | ------- |
| warm `check()`  | ~422 ms   | ~6.5 ms    | ~65x    |
| edit loop       | ~362 ms   | ~60 ms     | ~6x     |
| cold first check | —        | ~328 ms    | —       |

Because the win was large, none of the items below are urgent. This is a parking
lot for when the remaining costs (the ~328 ms first build, the ~60 ms edit, or
browser-thread responsiveness) actually start to matter.

Reproduce the current numbers any time with:

```bash
bun run profile:typecheck
```

## Where the remaining time goes

- **First `check()` (~328 ms):** one-time extraction of the filesystem into a
  Map (`extractFilesToMap` in `src/typecheck/environment.ts`) plus the initial
  parse/bind of all reachable `node_modules` `.d.ts` and lib files. FS read-all
  is only ~43 ms of this; the rest is TypeScript building the program.
- **Edit loop (~60 ms):** one incremental reparse of the edited file plus
  `getSemanticDiagnostics` re-checking the affected root files against the
  already-bound dependency graph.
- **`getAllPaths()` walk:** still O(tree) on each rebuild (only on
  `invalidate()` -> next `check()`), not per check.

## Follow-ups, roughly in priority order

### 1. Incremental dependency (`node_modules`) updates
Today a dependency install/uninstall is handled by `invalidate()`, which throws
away the env and rebuilds on the next `check()` (re-reading and re-binding all of
`node_modules`). This is the right v1 trade-off — installs are rare and the FS
read is cheap — but it forfeits the cached program.

Options when this matters:
- Inject only the changed dependency files into the live System
  (`env.sys.writeFile` / a non-root create path) and force a single project
  version bump so the language service re-resolves without a full rebuild.
- Since we own the install module (`src/install/`), have it emit a single
  "dependencies changed" event with the affected package paths, so the session
  can apply a targeted update instead of a blind rebuild.

Note: the current `apply()` auto-invalidates on any `node_modules/...` path or
non-source file (e.g. `package.json`, `tsconfig.json`) as a safety net; that is
the hook point to make smarter.

### 2. Lazy file loading instead of eager Map extraction
`extractFilesToMap` eagerly reads every relevant file (including the large,
mostly-unused majority of each dependency's `.d.ts`). A custom
`CompilerHost`/`System` backed by the FS with a content cache would let
TypeScript read only the declaration files actually reachable from imports.

The wrinkle: the FS is async but the TS host is sync. The likely shape is to
pre-index *paths* cheaply (for `fileExists`/`getDirectories`/`directoryExists`,
which already use the O(1) `directoryIndex`) and lazily read+cache *contents* on
demand. This mainly attacks the first-build time and memory.

### 3. Run the session in a Web Worker
For browser UX, move the session (and the synchronous `getAllPaths` walk + the
first parse/bind) off the main thread so type-checking never janks the UI. Pairs
naturally with the persistent model: the worker owns the long-lived env and the
main thread posts file-change notifications and awaits diagnostics.

### 4. Persist libs (and a dependency snapshot) across reloads
Lib files are currently cached at module scope (`src/typecheck/session.ts`), so a
page reload refetches them from the CDN. Persisting them in IndexedDB / the Cache
API removes that network round-trip and enables offline use. Bundling the libs
outright is an alternative that drops the network dependency entirely. A similar
idea could snapshot a built dependency Map.

### 5. Cheaper rebuild scan
When a rebuild is required, `getAllPaths()` walks the whole tree including
`node_modules`. Once the dependency set is known, the walk could skip
`node_modules` and only re-enumerate project files, shrinking rebuild cost.

### 6. Expose editor language features
`src/typecheck/services.ts` already implements `getCompletions`, `getQuickInfo`,
and `getDefinitions` against the env, but the session does not surface them. If we
move toward an in-browser editor, expose these (and `updateFile` partial-span
updates) through the session so completions/hover/go-to-definition reuse the same
persistent program.

### 7. Auto-detect option/mode changes
Changing `compilerOptions`, `mode`, or `libMap` mid-session currently requires the
caller to `invalidate()`. The session could hash these inputs and rebuild
automatically when they change, making misuse impossible.

## Already done (for reference)

- Persistent, incremental env with caller-driven `changed`/`created`/`deleted`
  notifications (tier 2).
- O(1) `getDirectories` and `directoryExists` via a precomputed `directoryIndex`.
- `skipLibCheck` defaulted on (respecting explicit opt-out) and optional
  suggestion diagnostics (`includeSuggestions`) for an errors-only fast path
  (tier 1). These proved marginal for the large-deps case but remain correct,
  low-risk defaults.
