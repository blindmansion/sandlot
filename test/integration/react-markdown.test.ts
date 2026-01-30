/**
 * Integration test for react-markdown package
 *
 * Tests install, typecheck, and build for react-markdown.
 * Uses pinned version to leverage disk cache and avoid esm.sh transient errors.
 */

import { describe, test, expect, setDefaultTimeout } from "bun:test";
import { withSandbox } from "../harness/index.ts";

setDefaultTimeout(30000);

describe("react-markdown", () => {
  const getSandbox = withSandbox();

  test("installs, typechecks, and builds", async () => {
    const { sandbox } = getSandbox();

    await sandbox.exec("sandlot install react-markdown@10.1.0");

    sandbox.writeFile(
      "/index.tsx",
      `import ReactMarkdown from 'react-markdown';

// Verify the component type exists
type MarkdownComponent = typeof ReactMarkdown;

console.log('ReactMarkdown:', typeof ReactMarkdown);

export function main() {
  return typeof ReactMarkdown;
}`
    );

    // Typecheck
    const typecheckResult = await sandbox.typecheck({ entryPoint: "/index.tsx" });
    if (!typecheckResult.success) {
      console.log("Diagnostics:", JSON.stringify(typecheckResult.diagnostics, null, 2));
    }
    expect(typecheckResult.success).toBe(true);

    // Build
    const buildResult = await sandbox.build({ entryPoint: "/index.tsx" });
    if (!buildResult.success) {
      console.log("Build error:", buildResult.message);
    }
    expect(buildResult.success).toBe(true);
  });
});
