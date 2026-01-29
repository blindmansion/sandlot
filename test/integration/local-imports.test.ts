/**
 * Integration tests for local file imports
 */

import { describe, test, expect } from "bun:test";
import { withSandbox } from "../harness/index.ts";

describe("local imports", () => {
  const getSandbox = withSandbox();

  test("multiple local files with imports", async () => {
    const { sandbox } = getSandbox();

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
      "/test-local.ts",
      `import { add, multiply } from './utils/math';
import { capitalize, reverse } from './utils/strings';

console.log('add(2, 3):', add(2, 3));
console.log('multiply(4, 5):', multiply(4, 5));
console.log('capitalize("hello"):', capitalize('hello'));
console.log('reverse("world"):', reverse('world'));`
    );

    const result = await sandbox.run({
      entryPoint: "/test-local.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.logs.join("\n")).toContain("add(2, 3): 5");
    expect(result.logs.join("\n")).toContain("multiply(4, 5): 20");
    expect(result.logs.join("\n")).toContain('capitalize("hello"): Hello');
    expect(result.logs.join("\n")).toContain('reverse("world"): dlrow');
  });

  test("async/await and Promises", async () => {
    const { sandbox } = getSandbox();

    sandbox.writeFile(
      "/test-async.ts",
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

    const result = await sandbox.run({
      entryPoint: "/test-async.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.logs.join("\n")).toContain("Starting async test...");
    expect(result.logs.join("\n")).toContain("Result: data loaded");
    expect(result.logs.join("\n")).toContain("Parallel results:");
    expect(result.returnValue).toBe("async test complete");
  });

  test("re-exports and barrel files", async () => {
    const { sandbox } = getSandbox();

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
      "/test-barrel.ts",
      `import { A, B, C, ALL } from './lib';
console.log('A:', A);
console.log('B:', B);
console.log('C:', C);
console.log('ALL:', ALL);`
    );

    const result = await sandbox.run({
      entryPoint: "/test-barrel.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.logs.join("\n")).toContain("A: module A");
    expect(result.logs.join("\n")).toContain("B: module B");
    expect(result.logs.join("\n")).toContain("C: module C");
    expect(result.logs.join("\n")).toContain("ALL: all modules");
  });

  test("JSON imports", async () => {
    const { sandbox } = getSandbox();

    sandbox.writeFile(
      "/data/config.json",
      JSON.stringify({ version: "1.0.0", features: ["a", "b", "c"] }, null, 2)
    );

    sandbox.writeFile(
      "/test-json.ts",
      `import config from './data/config.json';
console.log('Config version:', config.version);
console.log('Features:', config.features);`
    );

    const result = await sandbox.run({
      entryPoint: "/test-json.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.logs.join("\n")).toContain("Config version: 1.0.0");
    expect(result.logs.join("\n")).toContain("Features:");
  });

  test("default and named exports mixed", async () => {
    const { sandbox } = getSandbox();

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
      "/test-mixed.ts",
      `import greet, { VERSION, add } from './mymodule';
console.log(greet('World'));
console.log('Version:', VERSION);
console.log('1 + 2 =', add(1, 2));`
    );

    const result = await sandbox.run({
      entryPoint: "/test-mixed.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.logs.join("\n")).toContain("Hello, World!");
    expect(result.logs.join("\n")).toContain("Version: 2.0");
    expect(result.logs.join("\n")).toContain("1 + 2 = 3");
  });
});
