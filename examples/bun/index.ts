import { createNodeSandlot } from "sandlot/node";

console.log("=".repeat(60));
console.log("Sandlot Node/Bun Integration Tests");
console.log("=".repeat(60));

const sandlot = await createNodeSandlot();
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
  }
}

// =============================================================================
// Test 1: Basic single package (nanoid)
// =============================================================================
await runTest("Basic single package (nanoid)", async () => {
  await sandbox.exec("sandlot install nanoid");
  sandbox.writeFile(
    "/test1.ts",
    `import { nanoid } from 'nanoid';
console.log('nanoid:', nanoid());`
  );
  const result = await sandbox.run({ entryPoint: "/test1.ts", skipTypecheck: true });
  if (!result.success) throw new Error(result.error);
  console.log("Output:", result.logs.join("\n"));
});

// =============================================================================
// Test 2: Multiple packages
// =============================================================================
await runTest("Multiple packages (lodash-es + date-fns)", async () => {
  await sandbox.exec("sandlot install lodash-es");
  await sandbox.exec("sandlot install date-fns");
  sandbox.writeFile(
    "/test2.ts",
    `import { chunk, uniq } from 'lodash-es';
import { format } from 'date-fns';

const arr = [1, 2, 2, 3, 3, 3, 4, 5];
console.log('uniq:', uniq(arr));
console.log('chunk:', chunk([1, 2, 3, 4, 5, 6], 2));
console.log('date:', format(new Date(2024, 0, 15), 'yyyy-MM-dd'));`
  );
  const result = await sandbox.run({ entryPoint: "/test2.ts", skipTypecheck: true });
  if (!result.success) throw new Error(result.error);
  console.log("Output:", result.logs.join("\n"));
});

// =============================================================================
// Test 3: Package with subpath imports
// =============================================================================
await runTest("Subpath imports (lodash-es/debounce)", async () => {
  sandbox.writeFile(
    "/test3.ts",
    `import debounce from 'lodash-es/debounce';
console.log('debounce type:', typeof debounce);
console.log('debounce is function:', typeof debounce === 'function');`
  );
  const result = await sandbox.run({ entryPoint: "/test3.ts", skipTypecheck: true });
  if (!result.success) throw new Error(result.error);
  console.log("Output:", result.logs.join("\n"));
});

// =============================================================================
// Test 4: Multiple local files with imports
// =============================================================================
await runTest("Multiple local files with imports", async () => {
  sandbox.writeFile(
    "/utils/math.ts",
    `export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}`
  );
  sandbox.writeFile(
    "/utils/strings.ts",
    `export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function reverse(s: string): string {
  return s.split('').reverse().join('');
}`
  );
  sandbox.writeFile(
    "/test4.ts",
    `import { add, multiply } from './utils/math';
import { capitalize, reverse } from './utils/strings';

console.log('add(2, 3):', add(2, 3));
console.log('multiply(4, 5):', multiply(4, 5));
console.log('capitalize("hello"):', capitalize('hello'));
console.log('reverse("world"):', reverse('world'));`
  );
  const result = await sandbox.run({ entryPoint: "/test4.ts", skipTypecheck: true });
  if (!result.success) throw new Error(result.error);
  console.log("Output:", result.logs.join("\n"));
});

// =============================================================================
// Test 5: Async/await and Promises
// =============================================================================
await runTest("Async/await and Promises", async () => {
  sandbox.writeFile(
    "/test5.ts",
    `async function fetchData(): Promise<string> {
  return new Promise((resolve) => {
    setTimeout(() => resolve('data loaded'), 10);
  });
}

export async function main() {
  console.log('Starting async test...');
  const result = await fetchData();
  console.log('Result:', result);
  
  const parallel = await Promise.all([
    Promise.resolve(1),
    Promise.resolve(2),
    Promise.resolve(3),
  ]);
  console.log('Parallel results:', parallel);
  
  return 'async test complete';
}`
  );
  const result = await sandbox.run({ entryPoint: "/test5.ts", skipTypecheck: true });
  if (!result.success) throw new Error(result.error);
  console.log("Output:", result.logs.join("\n"));
  console.log("Return value:", result.returnValue);
});

// =============================================================================
// Test 6: Package that transitively imports other packages
// =============================================================================
await runTest("Package with transitive dependencies (zod)", async () => {
  await sandbox.exec("sandlot install zod");
  sandbox.writeFile(
    "/test6.ts",
    `import { z } from 'zod';

const UserSchema = z.object({
  name: z.string(),
  age: z.number().min(0),
  email: z.string().email(),
});

const validUser = { name: 'Alice', age: 30, email: 'alice@example.com' };
const invalidUser = { name: 'Bob', age: -5, email: 'not-an-email' };

console.log('Valid user:', UserSchema.safeParse(validUser).success);
console.log('Invalid user:', UserSchema.safeParse(invalidUser).success);`
  );
  const result = await sandbox.run({ entryPoint: "/test6.ts", skipTypecheck: true });
  if (!result.success) throw new Error(result.error);
  console.log("Output:", result.logs.join("\n"));
});

// =============================================================================
// Test 7: Re-exports and barrel files
// =============================================================================
await runTest("Re-exports and barrel files", async () => {
  sandbox.writeFile("/lib/a.ts", `export const A = 'module A';`);
  sandbox.writeFile("/lib/b.ts", `export const B = 'module B';`);
  sandbox.writeFile("/lib/c.ts", `export const C = 'module C';`);
  sandbox.writeFile(
    "/lib/index.ts",
    `export { A } from './a';
export { B } from './b';
export { C } from './c';
export const ALL = 'all modules';`
  );
  sandbox.writeFile(
    "/test7.ts",
    `import { A, B, C, ALL } from './lib';
console.log('A:', A);
console.log('B:', B);
console.log('C:', C);
console.log('ALL:', ALL);`
  );
  const result = await sandbox.run({ entryPoint: "/test7.ts", skipTypecheck: true });
  if (!result.success) throw new Error(result.error);
  console.log("Output:", result.logs.join("\n"));
});

// =============================================================================
// Test 8: JSON imports
// =============================================================================
await runTest("JSON imports", async () => {
  sandbox.writeFile(
    "/data/config.json",
    JSON.stringify({ version: "1.0.0", features: ["a", "b", "c"] }, null, 2)
  );
  sandbox.writeFile(
    "/test8.ts",
    `import config from './data/config.json';
console.log('Config version:', config.version);
console.log('Features:', config.features);`
  );
  const result = await sandbox.run({ entryPoint: "/test8.ts", skipTypecheck: true });
  if (!result.success) throw new Error(result.error);
  console.log("Output:", result.logs.join("\n"));
});

// =============================================================================
// Test 9: Default and named exports mixed
// =============================================================================
await runTest("Default and named exports mixed", async () => {
  sandbox.writeFile(
    "/mymodule.ts",
    `export default function greet(name: string) {
  return \`Hello, \${name}!\`;
}

export const VERSION = '2.0';
export function add(a: number, b: number) {
  return a + b;
}`
  );
  sandbox.writeFile(
    "/test9.ts",
    `import greet, { VERSION, add } from './mymodule';
console.log(greet('World'));
console.log('Version:', VERSION);
console.log('1 + 2 =', add(1, 2));`
  );
  const result = await sandbox.run({ entryPoint: "/test9.ts", skipTypecheck: true });
  if (!result.success) throw new Error(result.error);
  console.log("Output:", result.logs.join("\n"));
});

// =============================================================================
// Test 10: Namespace imports
// =============================================================================
await runTest("Namespace imports", async () => {
  sandbox.writeFile(
    "/test10.ts",
    `import * as lodash from 'lodash-es';
console.log('lodash.chunk:', lodash.chunk([1, 2, 3, 4], 2));
console.log('lodash.compact:', lodash.compact([0, 1, false, 2, '', 3]));`
  );
  const result = await sandbox.run({ entryPoint: "/test10.ts", skipTypecheck: true });
  if (!result.success) throw new Error(result.error);
  console.log("Output:", result.logs.join("\n"));
});

// =============================================================================
// Test 11: Tailwind CSS processing
// =============================================================================
await runTest("Tailwind CSS processing", async () => {
  sandbox.writeFile(
    "/tailwind-test.tsx",
    `// Component with Tailwind classes
export function Card() {
  return (
    <div className="p-4 bg-blue-500 text-white rounded-lg shadow-md hover:bg-blue-600 transition-colors">
      <h2 className="text-xl font-bold mb-2">Hello Tailwind</h2>
      <p className="text-sm opacity-80">This uses Tailwind CSS classes!</p>
      <button className="mt-4 px-4 py-2 bg-white text-blue-500 rounded hover:bg-gray-100">
        Click me
      </button>
    </div>
  );
}

console.log('Tailwind component defined');`
  );

  // Build with Tailwind enabled
  const buildResult = await sandbox.build({
    entryPoint: "/tailwind-test.tsx",
    skipTypecheck: true,
    tailwind: true,
  });

  if (!buildResult.success) {
    throw new Error(`Build failed: ${JSON.stringify(buildResult)}`);
  }

  console.log("Build successful!");
  console.log(`Bundle size: ${(buildResult.code.length / 1024).toFixed(2)} KB`);

  // Check if Tailwind CSS was generated (look for some expected CSS)
  const hasBackgroundBlue = buildResult.code.includes('bg-blue-500') ||
    buildResult.code.includes('--tw-') ||
    buildResult.code.includes('background-color');
  const hasPadding = buildResult.code.includes('padding') || buildResult.code.includes('p-4');
  const hasStyleInjection = buildResult.code.includes('createElement') &&
    buildResult.code.includes('style');

  console.log("Contains Tailwind CSS markers:", hasBackgroundBlue || hasPadding);
  console.log("Contains style injection code:", hasStyleInjection);

  // Show a snippet of the generated code (first 500 chars of CSS injection)
  const cssMatch = buildResult.code.match(/style\.textContent\s*=\s*"([^"]{0,800})/);
  if (cssMatch) {
    console.log("\nGenerated CSS preview (first 500 chars):");
    console.log(cssMatch[1]?.slice(0, 500) + "...");
  }
});

// =============================================================================
// Summary
// =============================================================================
console.log("\n" + "=".repeat(60));
console.log("All tests completed!");
console.log("=".repeat(60));

// Clean up
await sandlot.dispose();