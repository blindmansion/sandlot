# Test fixtures

Each subdirectory here is a self-contained **fixture**: a small tree of real
source files representing a project to load into the test filesystem.

## How fixtures are used

The harness (`test/helpers/harness.ts`) loads a fixture by copying it into a
fresh OS temp directory and exposing it through `NodeUnionFs` — a real,
`node:fs`-backed filesystem that implements the union of all three module
filesystem interfaces (`InstallFileSystem`, `BundleFileSystem`,
`TypecheckFileSystem`).

```ts
import { loadFixture } from "../helpers";

const ws = await loadFixture("basic");
try {
  // ws.fs   -> NodeUnionFs rooted at the temp copy
  // ws.root -> real temp dir backing the virtual "/"
  const pkg = await ws.fs.readFile("/package.json");
} finally {
  await ws.cleanup();
}
```

The temp copy means tests can freely mutate the tree (install packages, write
bundles, create symlinks) without modifying anything committed here.

## Conventions

- The fixture directory root maps to the virtual filesystem root (`/`). So
  `test/fixtures/basic/package.json` is read as `/package.json`.
- Keep fixtures minimal and focused on one scenario.
- Prefer plain source files; avoid committing `node_modules`.
