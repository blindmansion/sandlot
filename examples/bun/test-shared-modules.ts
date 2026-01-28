import { createNodeSandlot } from "sandlot/node";

console.log("=".repeat(60));
console.log("Shared Module Registry Tests");
console.log("=".repeat(60));

// =============================================================================
// Create some fake "modules" to share with the sandbox
// =============================================================================

const myLogger = {
  log: (...args: unknown[]) => console.log("[myLogger]", ...args),
  warn: (...args: unknown[]) => console.warn("[myLogger]", ...args),
  error: (...args: unknown[]) => console.error("[myLogger]", ...args),
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

// =============================================================================
// Create sandlot with shared modules
// =============================================================================

console.log("\nCreating sandlot with shared modules...");

const sandlot = await createNodeSandlot({
  sharedModules: {
    "my-logger": myLogger,
    "my-math": myMath,
    "my-utils": myUtils,
  },
});

// Verify the registry was created
if (!sandlot.sharedModules) {
  console.error("✗ FAIL: sharedModules registry is null");
  process.exit(1);
}

console.log("✓ SharedModuleRegistry created");
console.log(`  Registry key: ${sandlot.sharedModules.registryKey}`);
console.log(`  Registered modules: ${sandlot.sharedModules.list().join(", ")}`);

const sandbox = await sandlot.createSandbox();

// Helper to run a test case
async function runTest(name: string, fn: () => Promise<void>) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`TEST: ${name}`);
  console.log("─".repeat(60));
  try {
    await fn();
    console.log(`✓ ${name} passed`);
  } catch (err) {
    console.error(`✗ ${name} failed:`, err);
    process.exit(1);
  }
}

// =============================================================================
// Test 1: Basic import and use of shared module
// =============================================================================
await runTest("Basic shared module import", async () => {
  sandbox.writeFile(
    "/test-shared-1.ts",
    `import logger from 'my-logger';
logger.log('Hello from sandboxed code!');
logger.warn('This is a warning');`
  );

  const result = await sandbox.run({ entryPoint: "/test-shared-1.ts", skipTypecheck: true });
  if (!result.success) {
    throw new Error(result.error ?? "Unknown error");
  }
  console.log("Output:", result.logs.join("\n"));

  // Verify the logger was actually called (output should contain our prefix)
  const hasLoggerOutput = result.logs.some((log) => log.includes("[myLogger]"));
  if (!hasLoggerOutput) {
    throw new Error("Expected logger output with [myLogger] prefix");
  }
});

// =============================================================================
// Test 2: Named exports from shared module
// =============================================================================
await runTest("Named exports from shared module", async () => {
  sandbox.writeFile(
    "/test-shared-2.ts",
    `import { add, multiply, PI } from 'my-math';

console.log('add(2, 3) =', add(2, 3));
console.log('multiply(4, 5) =', multiply(4, 5));
console.log('PI =', PI);`
  );

  const result = await sandbox.run({ entryPoint: "/test-shared-2.ts", skipTypecheck: true });
  if (!result.success) {
    throw new Error(result.error ?? "Unknown error");
  }
  console.log("Output:", result.logs.join("\n"));

  // Verify correct values
  if (!result.logs.some((log) => log.includes("add(2, 3) = 5"))) {
    throw new Error("add() didn't work correctly");
  }
  if (!result.logs.some((log) => log.includes("multiply(4, 5) = 20"))) {
    throw new Error("multiply() didn't work correctly");
  }
  if (!result.logs.some((log) => log.includes("PI = 3.14159"))) {
    throw new Error("PI constant not accessible");
  }
});

// =============================================================================
// Test 3: Default export from shared module
// =============================================================================
await runTest("Default export from shared module", async () => {
  sandbox.writeFile(
    "/test-shared-3.ts",
    `import myMath from 'my-math';
import myUtils from 'my-utils';

console.log('myMath.version:', myMath.version);
console.log('myUtils():', myUtils());`
  );

  const result = await sandbox.run({ entryPoint: "/test-shared-3.ts", skipTypecheck: true });
  if (!result.success) {
    throw new Error(result.error ?? "Unknown error");
  }
  console.log("Output:", result.logs.join("\n"));

  if (!result.logs.some((log) => log.includes("myMath.version: 1.0.0"))) {
    throw new Error("Default export from my-math not working");
  }
  if (!result.logs.some((log) => log.includes("I am the default export"))) {
    throw new Error("Default export from my-utils not working");
  }
});

// =============================================================================
// Test 4: Mixed default and named imports
// =============================================================================
await runTest("Mixed default and named imports", async () => {
  sandbox.writeFile(
    "/test-shared-4.ts",
    `import utils, { greet, reverse } from 'my-utils';

console.log('greet:', greet('World'));
console.log('reverse:', reverse('hello'));
console.log('default export:', utils());`
  );

  const result = await sandbox.run({ entryPoint: "/test-shared-4.ts", skipTypecheck: true });
  if (!result.success) {
    throw new Error(result.error ?? "Unknown error");
  }
  console.log("Output:", result.logs.join("\n"));

  if (!result.logs.some((log) => log.includes("Hello, World!"))) {
    throw new Error("greet() not working");
  }
  if (!result.logs.some((log) => log.includes("olleh"))) {
    throw new Error("reverse() not working");
  }
});

// =============================================================================
// Test 5: Shared module used alongside npm packages
// =============================================================================
await runTest("Shared module with npm packages", async () => {
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

  const result = await sandbox.run({ entryPoint: "/test-shared-5.ts", skipTypecheck: true });
  if (!result.success) {
    throw new Error(result.error ?? "Unknown error");
  }
  console.log("Output:", result.logs.join("\n"));

  if (!result.logs.some((log) => log.includes("nanoid length: 10"))) {
    throw new Error("nanoid not working");
  }
  if (!result.logs.some((log) => log.includes("add from shared: 300"))) {
    throw new Error("shared module not working alongside npm package");
  }
});

// =============================================================================
// Test 6: Namespace import of shared module
// =============================================================================
await runTest("Namespace import of shared module", async () => {
  sandbox.writeFile(
    "/test-shared-6.ts",
    `import * as math from 'my-math';

console.log('math.add:', math.add(10, 20));
console.log('math.PI:', math.PI);
console.log('has multiply:', typeof math.multiply === 'function');`
  );

  const result = await sandbox.run({ entryPoint: "/test-shared-6.ts", skipTypecheck: true });
  if (!result.success) {
    throw new Error(result.error ?? "Unknown error");
  }
  console.log("Output:", result.logs.join("\n"));

  if (!result.logs.some((log) => log.includes("math.add: 30"))) {
    throw new Error("namespace import not working");
  }
});

// =============================================================================
// Test 7: Multiple files importing shared modules
// =============================================================================
await runTest("Multiple files importing shared modules", async () => {
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
logger.log('Sum:', result.sum);
logger.log('Product:', result.product);`
  );

  const result = await sandbox.run({ entryPoint: "/test-shared-7.ts", skipTypecheck: true });
  if (!result.success) {
    throw new Error(result.error ?? "Unknown error");
  }
  console.log("Output:", result.logs.join("\n"));

  if (!result.logs.some((log) => log.includes("Sum: 13"))) {
    throw new Error("Multi-file shared module import not working");
  }
  if (!result.logs.some((log) => log.includes("Product: 42"))) {
    throw new Error("Multi-file shared module import not working");
  }
});

// =============================================================================
// Summary
// =============================================================================
console.log("\n" + "=".repeat(60));
console.log("All shared module tests passed!");
console.log("=".repeat(60));
