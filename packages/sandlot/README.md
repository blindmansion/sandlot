# Sandlot

Browser-based TypeScript sandbox with esbuild bundling and type checking. Designed for AI agent workflows where code needs to be written, validated, and executed in real-time, all in the browser.

## Installation

```bash
npm install sandlot
```

## Quick Start

```typescript
import { createBuilder, registerSharedModules } from "sandlot";
import * as React from "react";

// Share React with dynamic code to avoid duplicate instances
registerSharedModules({ react: React });

// Create a reusable builder
const runAgent = createBuilder({
  sandboxOptions: { sharedModules: ["react"] },
  build: async (sandbox, prompt) => {
    // Your agent logic here - execute commands via sandbox.bash.exec()
    await sandbox.bash.exec(
      'echo "export const App = () => <div>Hello</div>" > /src/index.tsx',
    );
    await sandbox.bash.exec("build /src/index.tsx");
  },
});

// Run with a prompt
const result = await runAgent("Create a counter component");

if (result.module?.App) {
  // Use the generated component
  const App = result.module.App as React.ComponentType;
}
```

## Builder API

The `createBuilder()` function is the primary API for agent workflows. It handles sandbox lifecycle, build capture, validation, and cancellation.

### `createBuilder(options)`

Returns a reusable builder function that can be called with different prompts.

```typescript
const runAgent = createBuilder<T>({
  // Sandbox configuration (pick one)
  sandbox?: Sandbox,           // Reuse an existing sandbox (state persists between calls)
  sandboxOptions?: SandboxOptions, // Create fresh sandbox per call (isolated runs)

  // Your agent logic
  build: (sandbox: Sandbox, prompt: string) => Promise<T>,
});
```

#### Options

| Option           | Type                              | Description                                             |
| ---------------- | --------------------------------- | ------------------------------------------------------- |
| `sandbox`        | `Sandbox`                         | Existing sandbox to reuse. Files persist between calls. |
| `sandboxOptions` | `SandboxOptions`                  | Options for creating fresh sandboxes per call.          |
| `build`          | `(sandbox, prompt) => Promise<T>` | Your agent logic. Receives the sandbox and prompt.      |

### Calling the Builder

```typescript
const result = await runAgent(prompt, options?);
```

#### Call Options

| Option     | Type            | Description                                                     |
| ---------- | --------------- | --------------------------------------------------------------- |
| `validate` | `(module) => M` | Validate exports during build. Errors are visible to the agent. |
| `timeout`  | `number`        | Max time in ms. Throws `AbortError` if exceeded.                |
| `signal`   | `AbortSignal`   | For external cancellation.                                      |

#### Result

```typescript
interface BuildResult<T, M> {
  result: T | undefined; // Return value from your build function
  error: Error | null; // Error if build function threw
  bundle: BundleResult | null; // The compiled JavaScript bundle
  module: M | null; // Loaded module exports (validated if validate provided)
  sandbox: Sandbox; // The sandbox used (for inspection or reuse)
}
```

### Validation

Validation runs as part of the `build` command. If it throws, the build fails and the agent sees the error, allowing it to fix the code and retry.

```typescript
const result = await runAgent("Create a counter", {
  validate: (mod) => {
    if (typeof mod.App !== "function") {
      throw new Error("Must export an App component");
    }
    return { App: mod.App as React.ComponentType };
  },
});
// result.module is typed as { App: React.ComponentType } | null
```

With Zod:

```typescript
import { z } from "zod";

const Schema = z.object({
  App: z.custom<React.ComponentType>((v) => typeof v === "function"),
  initialCount: z.number().optional(),
});

const result = await runAgent("Create a counter", {
  validate: (mod) => Schema.parse(mod),
});
```

### Cancellation

```typescript
const controller = new AbortController();

const promise = runAgent("Create a dashboard", {
  signal: controller.signal,
  timeout: 60_000, // 1 minute
});

// Cancel on user action
cancelButton.onclick = () => controller.abort();
```

## Sandbox API

For lower-level control, use `createSandbox()` directly.

```typescript
import { createSandbox } from "sandlot";

const sandbox = await createSandbox({
  initialFiles: {
    "/src/index.ts": "export const x = 1;",
    "/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
  },
  sharedModules: ["react", "react-dom/client"],
  onBuild: (result) => console.log("Build succeeded:", result),
});

// Execute shell commands
await sandbox.bash.exec("tsc /src/index.ts"); // Type check
await sandbox.bash.exec("build /src/index.ts"); // Bundle
await sandbox.bash.exec("install lodash"); // Install package
await sandbox.bash.exec("list"); // List packages

// Access the last successful build
if (sandbox.lastBuild) {
  const { bundle, module } = sandbox.lastBuild;
}

// Serialize state for persistence
const state = sandbox.getState();
localStorage.setItem("project", JSON.stringify(state));
```

### Sandbox Options

| Option          | Type                     | Description                                         |
| --------------- | ------------------------ | --------------------------------------------------- |
| `initialFiles`  | `Record<string, string>` | Files to populate the filesystem with.              |
| `sharedModules` | `string[]`               | Modules to resolve from host (e.g., `['react']`).   |
| `tsconfigPath`  | `string`                 | Path to tsconfig.json (default: `/tsconfig.json`).  |
| `onBuild`       | `(result) => void`       | Callback when a build succeeds.                     |
| `bashOptions`   | `SandboxBashOptions`     | Options for the just-bash shell (env, limits).      |

## Shell Commands

The sandbox provides these built-in commands:

| Command                   | Description                         |
| ------------------------- | ----------------------------------- |
| `tsc [entry]`             | Type check (uses tsconfig.json)     |
| `build [entry] [options]` | Bundle (runs typecheck first)       |
| `install <pkg>`           | Install npm package (fetches types) |
| `uninstall <pkg>`         | Remove package                      |
| `list`                    | List installed packages             |
| `run <entry>`             | Execute a script                    |

Build options: `--format <esm\|iife\|cjs>`, `--minify`, `--skip-typecheck`

## Shared Modules

To avoid duplicate library instances (important for React context/hooks), register shared modules before creating sandboxes:

```typescript
import { registerSharedModules } from "sandlot";
import * as React from "react";
import * as ReactDOM from "react-dom/client";

registerSharedModules({
  react: React,
  "react-dom/client": ReactDOM,
});
```

Then include them in `sharedModules` when creating a sandbox.

## Cross-Origin Isolation

For optimal esbuild-wasm performance, enable cross-origin isolation by adding these headers to your dev server:

```
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Opener-Policy: same-origin
```

In Vite:

```typescript
export default defineConfig({
  plugins: [
    {
      name: "isolation",
      configureServer: (server) => {
        server.middlewares.use((_, res, next) => {
          res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          next();
        });
      },
    },
  ],
});
```

## License

MIT
