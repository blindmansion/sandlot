/**
 * Integration tests for shared module registry
 *
 * Tests the ability to inject host-side modules into the sandbox.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestSandbox, type TestSandbox } from "../harness/index.ts";

describe("shared modules", () => {
  // We need a custom sandlot with shared modules, so we can't use withSandbox()
  let testSandbox: TestSandbox;

  // Create fake modules to share with the sandbox
  const myLogger = {
    log: (...args: unknown[]) => `[myLogger] ${args.join(" ")}`,
    warn: (...args: unknown[]) => `[myLogger WARN] ${args.join(" ")}`,
    error: (...args: unknown[]) => `[myLogger ERROR] ${args.join(" ")}`,
  };

  const myMath = {
    add: (a: number, b: number) => a + b,
    multiply: (a: number, b: number) => a * b,
    PI: 3.14159,
    default: { version: "1.0.0" },
  };

  const myUtils = {
    greet: (name: string) => `Hello, ${name}!`,
    reverse: (s: string) => s.split("").reverse().join(""),
    default: function defaultExport() {
      return "I am the default export";
    },
  };

  beforeAll(async () => {
    testSandbox = await createTestSandbox({
      sharedModules: {
        "my-logger": myLogger,
        "my-math": myMath,
        "my-utils": myUtils,
      },
    });
  });

  afterAll(async () => {
    await testSandbox.sandlot.dispose();
  });

  test("shared module registry is created", () => {
    const { sandlot } = testSandbox;

    expect(sandlot.sharedModules).toBeDefined();
    expect(sandlot.sharedModules!.list()).toContain("my-logger");
    expect(sandlot.sharedModules!.list()).toContain("my-math");
    expect(sandlot.sharedModules!.list()).toContain("my-utils");
  });

  test("basic shared module import", async () => {
    const { sandbox } = testSandbox;

    sandbox.writeFile(
      "/test-shared-1.ts",
      `import logger from 'my-logger';
console.log(logger.log('Hello from sandboxed code!'));
console.log(logger.warn('This is a warning'));`
    );

    const result = await sandbox.run({
      entryPoint: "/test-shared-1.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.logs.some((log) => log.includes("[myLogger]"))).toBe(true);
  });

  test("named exports from shared module", async () => {
    const { sandbox } = testSandbox;

    sandbox.writeFile(
      "/test-shared-2.ts",
      `import { add, multiply, PI } from 'my-math';

console.log('add(2, 3) =', add(2, 3));
console.log('multiply(4, 5) =', multiply(4, 5));
console.log('PI =', PI);`
    );

    const result = await sandbox.run({
      entryPoint: "/test-shared-2.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.logs.some((log) => log.includes("add(2, 3) = 5"))).toBe(true);
    expect(result.logs.some((log) => log.includes("multiply(4, 5) = 20"))).toBe(
      true
    );
    expect(result.logs.some((log) => log.includes("PI = 3.14159"))).toBe(true);
  });

  test("default export from shared module", async () => {
    const { sandbox } = testSandbox;

    sandbox.writeFile(
      "/test-shared-3.ts",
      `import myMath from 'my-math';
import myUtils from 'my-utils';

console.log('myMath.version:', myMath.version);
console.log('myUtils():', myUtils());`
    );

    const result = await sandbox.run({
      entryPoint: "/test-shared-3.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.logs.some((log) => log.includes("myMath.version: 1.0.0"))).toBe(
      true
    );
    expect(
      result.logs.some((log) => log.includes("I am the default export"))
    ).toBe(true);
  });

  test("mixed default and named imports", async () => {
    const { sandbox } = testSandbox;

    sandbox.writeFile(
      "/test-shared-4.ts",
      `import utils, { greet, reverse } from 'my-utils';

console.log('greet:', greet('World'));
console.log('reverse:', reverse('hello'));
console.log('default export:', utils());`
    );

    const result = await sandbox.run({
      entryPoint: "/test-shared-4.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.logs.some((log) => log.includes("Hello, World!"))).toBe(true);
    expect(result.logs.some((log) => log.includes("olleh"))).toBe(true);
  });

  test("shared module used alongside npm packages", async () => {
    const { sandbox } = testSandbox;

    await sandbox.exec("sandlot install nanoid");

    sandbox.writeFile(
      "/test-shared-5.ts",
      `import { nanoid } from 'nanoid';
import { add } from 'my-math';

const id = nanoid(10);
console.log('nanoid generated:', id);
console.log('nanoid length:', id.length);
console.log('add from shared:', add(100, 200));`
    );

    const result = await sandbox.run({
      entryPoint: "/test-shared-5.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.logs.some((log) => log.includes("nanoid length: 10"))).toBe(
      true
    );
    expect(result.logs.some((log) => log.includes("add from shared: 300"))).toBe(
      true
    );
  });

  test("namespace import of shared module", async () => {
    const { sandbox } = testSandbox;

    sandbox.writeFile(
      "/test-shared-6.ts",
      `import * as math from 'my-math';

console.log('math.add:', math.add(10, 20));
console.log('math.PI:', math.PI);
console.log('has multiply:', typeof math.multiply === 'function');`
    );

    const result = await sandbox.run({
      entryPoint: "/test-shared-6.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.logs.some((log) => log.includes("math.add: 30"))).toBe(true);
  });

  test("multiple files importing shared modules", async () => {
    const { sandbox } = testSandbox;

    sandbox.writeFile(
      "/lib/calc.ts",
      `import { add, multiply } from 'my-math';

export function calculate(a: number, b: number) {
  return {
    sum: add(a, b),
    product: multiply(a, b),
  };
}`
    );

    sandbox.writeFile(
      "/test-shared-7.ts",
      `import { calculate } from './lib/calc';
import logger from 'my-logger';

const result = calculate(6, 7);
console.log(logger.log('Sum:', result.sum));
console.log(logger.log('Product:', result.product));`
    );

    const result = await sandbox.run({
      entryPoint: "/test-shared-7.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.logs.some((log) => log.includes("Sum:") && log.includes("13"))).toBe(
      true
    );
    expect(
      result.logs.some((log) => log.includes("Product:") && log.includes("42"))
    ).toBe(true);
  });
});
