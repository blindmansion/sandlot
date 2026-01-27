/**
 * Mock agent that errors during execution.
 *
 * Demonstrates error scenarios to test runner API behavior:
 * - What happens when an agent throws after a successful build?
 * - What happens when an agent throws before any build?
 */

import type { Sandbox } from "sandlot";

/**
 * Agent that successfully builds, then throws an error.
 *
 * This tests whether the runner can still surface the bundle
 * that was captured before the error occurred.
 */
export async function runMockAgentErrorAfterBuild(
  sandbox: Sandbox
): Promise<void> {
  // Write a valid component
  await sandbox.fs.writeFile(
    "/src/App.tsx",
    `export function App() {
  return <div>I was built before the error!</div>;
}
`
  );

  await sandbox.fs.writeFile(
    "/src/index.tsx",
    `export { App } from "./App";\nexport { App as default } from "./App";\n`
  );

  // Build successfully
  const buildResult = await sandbox.bash.exec("build /src/index.tsx");
  if (buildResult.exitCode !== 0) {
    throw new Error(`Build failed:\n${buildResult.stderr || buildResult.stdout}`);
  }

  // Simulate some post-build work that fails
  // (e.g., agent tries to do something else and crashes)
  await simulateWork(100);

  throw new Error(
    "Agent crashed after successful build! " +
      "The bundle was created but the agent failed during post-processing."
  );
}

/**
 * Agent that throws an error before any build occurs.
 *
 * This tests the case where the agent fails early and no bundle exists.
 */
export async function runMockAgentErrorBeforeBuild(
  sandbox: Sandbox
): Promise<void> {
  // Write a file to show some work was done
  await sandbox.fs.writeFile(
    "/src/App.tsx",
    `export function App() {
  return <div>I was never built</div>;
}
`
  );

  // Simulate agent thinking/working
  await simulateWork(100);

  // Crash before build
  throw new Error(
    "Agent crashed before building! " +
      "Files were written but no build was attempted."
  );
}

/**
 * Agent that writes invalid TypeScript and fails type checking.
 *
 * Tests how type errors surface through the runner.
 */
export async function runMockAgentTypeError(sandbox: Sandbox): Promise<void> {
  // Write invalid TypeScript
  await sandbox.fs.writeFile(
    "/src/App.tsx",
    `export function App() {
  // Type error: can't assign number to string
  const message: string = 42;
  return <div>{message}</div>;
}
`
  );

  await sandbox.fs.writeFile(
    "/src/index.tsx",
    `export { App } from "./App";\n`
  );

  // Type check - this should fail
  const tscResult = await sandbox.bash.exec("tsc /src/index.tsx");
  if (tscResult.exitCode !== 0) {
    throw new Error(`Type check failed:\n${tscResult.stderr || tscResult.stdout}`);
  }

  // Build (won't reach here)
  await sandbox.bash.exec("build /src/index.tsx");
}

function simulateWork(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
