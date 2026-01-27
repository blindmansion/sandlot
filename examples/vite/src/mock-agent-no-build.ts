/**
 * Mock agent that completes successfully but never builds.
 *
 * Demonstrates scenarios where the agent finishes its work
 * without producing a bundle. This tests how the runner API
 * surfaces "no build" vs "build failed" vs "build succeeded".
 */

import type { Sandbox } from "sandlot";

/**
 * Agent that writes files but forgets to build.
 *
 * This simulates an agent bug where it thinks it's done
 * but never actually compiled the code.
 */
export async function runMockAgentForgotToBuild(
  sandbox: Sandbox
): Promise<void> {
  // Write files like normal
  await sandbox.fs.writeFile(
    "/src/App.tsx",
    `export function App() {
  return <div>I exist but was never compiled!</div>;
}
`
  );

  await sandbox.fs.writeFile(
    "/src/index.tsx",
    `export { App } from "./App";\nexport { App as default } from "./App";\n`
  );

  // Type check passes
  const tscResult = await sandbox.bash.exec("tsc /src/index.tsx");
  if (tscResult.exitCode !== 0) {
    throw new Error(`Type check failed:\n${tscResult.stderr || tscResult.stdout}`);
  }

  // Oops! Agent returns without building
  // This could happen if:
  // - Agent thinks type check = build
  // - Agent has a logic bug
  // - Agent was interrupted/confused
  return;
}

/**
 * Agent that only does file operations, no compilation.
 *
 * Some agent tasks might legitimately not need a build,
 * but if the caller expects one, this is a problem.
 */
export async function runMockAgentOnlyWrites(sandbox: Sandbox): Promise<void> {
  // Just write some files
  await sandbox.fs.writeFile("/README.md", "# My Project\n");
  await sandbox.fs.writeFile("/src/utils.ts", "export const VERSION = '1.0.0';\n");
  await sandbox.fs.writeFile("/src/config.ts", "export const DEBUG = true;\n");

  // Agent completed its task (maybe it was asked to scaffold files)
  // No build was requested or expected by the agent
  return;
}

/**
 * Agent that attempts to build but the build fails silently.
 *
 * This simulates an agent that doesn't properly check build results
 * and incorrectly thinks the build succeeded.
 */
export async function runMockAgentIgnoresBuildFailure(
  sandbox: Sandbox
): Promise<void> {
  // Write invalid code that won't build
  await sandbox.fs.writeFile(
    "/src/App.tsx",
    `export function App() {
  // This has a syntax error - unclosed JSX
  return <div>
}
`
  );

  await sandbox.fs.writeFile(
    "/src/index.tsx",
    `export { App } from "./App";\n`
  );

  // Try to build but ignore the result
  // A buggy agent might do this
  await sandbox.bash.exec("build /src/index.tsx");

  // Agent thinks it's done, but bundle is null because build failed
  return;
}

/**
 * Agent that explicitly decides not to build.
 *
 * Returns information about why no build occurred.
 * This tests the pattern of returning metadata from the agent.
 */
export async function runMockAgentDeclinesToBuild(
  sandbox: Sandbox
): Promise<{ reason: string; filesWritten: string[] }> {
  const files = ["/src/types.ts", "/src/constants.ts"];

  await sandbox.fs.writeFile(
    "/src/types.ts",
    `export interface User { id: string; name: string; }\n`
  );

  await sandbox.fs.writeFile(
    "/src/constants.ts",
    `export const API_URL = "https://api.example.com";\n`
  );

  // Agent explicitly returns why it didn't build
  return {
    reason: "Task was to generate types only, no executable code needed",
    filesWritten: files,
  };
}
