/**
 * Integration tests for log isolation
 *
 * Verifies that console.log from sandboxed code is captured in result.logs
 * and doesn't leak to the host console.
 */

import { describe, test, expect } from "bun:test";
import { withSandbox } from "../harness/index.ts";

describe("log isolation", () => {
  const getSandbox = withSandbox();

  test("sandbox logs are captured in result.logs", async () => {
    const { sandbox } = getSandbox();

    sandbox.writeFile(
      "/test-logs.ts",
      `
console.log("SANDBOXED LOG: This is a regular log");
console.warn("SANDBOXED LOG: This is a warning");
console.error("SANDBOXED LOG: This is an error");
console.info("SANDBOXED LOG: This is info");

export function main() {
  console.log("SANDBOXED LOG: Inside main function");
  return { success: true };
}
`
    );

    const result = await sandbox.run({
      entryPoint: "/test-logs.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);

    // All console methods should be captured
    expect(result.logs.some((log) => log.includes("regular log"))).toBe(true);
    expect(result.logs.some((log) => log.includes("warning"))).toBe(true);
    expect(result.logs.some((log) => log.includes("error"))).toBe(true);
    expect(result.logs.some((log) => log.includes("info"))).toBe(true);
    expect(result.logs.some((log) => log.includes("Inside main function"))).toBe(
      true
    );

    // Return value should be captured
    expect(result.returnValue).toEqual({ success: true });
  });

  test("multiple console.log calls are captured in order", async () => {
    const { sandbox } = getSandbox();

    sandbox.writeFile(
      "/test-order.ts",
      `
console.log("first");
console.log("second");
console.log("third");

export function main() {
  console.log("fourth");
  return "done";
}
`
    );

    const result = await sandbox.run({
      entryPoint: "/test-order.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.logs.length).toBe(4);
    expect(result.logs[0]).toContain("first");
    expect(result.logs[1]).toContain("second");
    expect(result.logs[2]).toContain("third");
    expect(result.logs[3]).toContain("fourth");
  });

  test("console.log with multiple arguments", async () => {
    const { sandbox } = getSandbox();

    sandbox.writeFile(
      "/test-args.ts",
      `
console.log("value:", 42);
console.log("array:", [1, 2, 3]);
console.log("object:", { a: 1, b: 2 });
`
    );

    const result = await sandbox.run({
      entryPoint: "/test-args.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.logs.some((log) => log.includes("value:") && log.includes("42"))).toBe(true);
    expect(result.logs.some((log) => log.includes("array:"))).toBe(true);
    expect(result.logs.some((log) => log.includes("object:"))).toBe(true);
  });
});
