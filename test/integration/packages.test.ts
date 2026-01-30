/**
 * Integration tests for npm package installation and imports
 */

import { describe, test, expect } from "bun:test";
import { withSandbox } from "../harness/index.ts";

describe("npm packages", () => {
  const getSandbox = withSandbox();

  test("basic single package (nanoid)", async () => {
    const { sandbox } = getSandbox();

    await sandbox.exec("sandlot install nanoid");
    sandbox.writeFile(
      "/test-nanoid.ts",
      `import { nanoid } from 'nanoid';
console.log('nanoid:', nanoid());`
    );

    const result = await sandbox.run({
      entryPoint: "/test-nanoid.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.logs.some((log) => log.includes("nanoid:"))).toBe(true);
  });

  test(
    "multiple packages (lodash-es + date-fns)",
    async () => {
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install lodash-es");
      await sandbox.exec("sandlot install date-fns");

      sandbox.writeFile(
        "/test-multi.ts",
        `import { chunk, uniq } from 'lodash-es';
import { format } from 'date-fns';

const arr = [1, 2, 2, 3, 3, 3, 4, 5];
console.log('uniq:', uniq(arr));
console.log('chunk:', chunk([1, 2, 3, 4, 5, 6], 2));
console.log('date:', format(new Date(2024, 0, 15), 'yyyy-MM-dd'));`
      );

      const result = await sandbox.run({
        entryPoint: "/test-multi.ts",
        skipTypecheck: true,
      });

      expect(result.success).toBe(true);
      expect(result.logs.join("\n")).toContain("uniq:");
      expect(result.logs.join("\n")).toContain("chunk:");
      expect(result.logs.join("\n")).toContain("date: 2024-01-15");
    },
    { timeout: 30000 }
  );

  test("subpath imports (lodash-es/debounce)", async () => {
    const { sandbox } = getSandbox();

    sandbox.writeFile(
      "/test-subpath.ts",
      `import debounce from 'lodash-es/debounce';
console.log('debounce type:', typeof debounce);
console.log('debounce is function:', typeof debounce === 'function');`
    );

    const result = await sandbox.run({
      entryPoint: "/test-subpath.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.logs.join("\n")).toContain("debounce type: function");
    expect(result.logs.join("\n")).toContain("debounce is function: true");
  });

  test("package with complex exports (uuid)", async () => {
    const { sandbox } = getSandbox();

    // Use specific version to avoid esm.sh transient 500 errors with unversioned requests
    await sandbox.exec("sandlot install uuid@11.0.0");

    sandbox.writeFile(
      "/test-uuid.ts",
      `import { v4 as uuidv4, validate } from 'uuid';

const id = uuidv4();
console.log('uuid generated:', id);
console.log('uuid length:', id.length);
console.log('is valid uuid:', validate(id));`
    );

    const result = await sandbox.run({
      entryPoint: "/test-uuid.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.logs.join("\n")).toContain("uuid length: 36");
    expect(result.logs.join("\n")).toContain("is valid uuid: true");
  });

  test("namespace imports", async () => {
    const { sandbox } = getSandbox();

    sandbox.writeFile(
      "/test-namespace.ts",
      `import * as lodash from 'lodash-es';
console.log('lodash.chunk:', lodash.chunk([1, 2, 3, 4], 2));
console.log('lodash.compact:', lodash.compact([0, 1, false, 2, '', 3]));`
    );

    const result = await sandbox.run({
      entryPoint: "/test-namespace.ts",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    expect(result.logs.join("\n")).toContain("lodash.chunk:");
    expect(result.logs.join("\n")).toContain("lodash.compact:");
  });

  // =========================================================================
  // Typechecking tests - ensure types are cached for common packages
  // These tests have longer timeouts due to network requests for type fetching
  // =========================================================================

  describe("typechecking", () => {
    test(
      "nanoid typechecks successfully",
      async () => {
        const { sandbox } = getSandbox();

        await sandbox.exec("sandlot install nanoid@5.1.5");

        sandbox.writeFile(
          "/test-nanoid-types.ts",
          `import { nanoid, customAlphabet } from 'nanoid';

// Test basic usage
const id: string = nanoid();
const shortId: string = nanoid(10);

// Test custom alphabet
const customId = customAlphabet('abc123', 10);
const result: string = customId();

console.log('nanoid:', id);
console.log('custom:', result);

export function main() {
  return id;
}`
        );

        const typecheckResult = await sandbox.typecheck({
          entryPoint: "/test-nanoid-types.ts",
        });

        expect(typecheckResult.success).toBe(true);
      },
      { timeout: 30000 }
    );

    test(
      "lodash-es typechecks successfully",
      async () => {
        const { sandbox } = getSandbox();

        await sandbox.exec("sandlot install lodash-es@4.17.21");

        sandbox.writeFile(
          "/test-lodash-types.ts",
          `import { chunk, uniq, debounce, throttle } from 'lodash-es';

// Test array functions with proper types
const numbers: number[] = [1, 2, 2, 3, 3, 3];
const uniqueNumbers: number[] = uniq(numbers);
const chunkedNumbers: number[][] = chunk(numbers, 2);

// Test function utilities
const debouncedFn = debounce((x: number) => x * 2, 100);
const throttledFn = throttle((x: string) => x.toUpperCase(), 100);

console.log('unique:', uniqueNumbers);
console.log('chunked:', chunkedNumbers);

export function main() {
  return uniqueNumbers;
}`
        );

        const typecheckResult = await sandbox.typecheck({
          entryPoint: "/test-lodash-types.ts",
        });

        expect(typecheckResult.success).toBe(true);
      },
      { timeout: 30000 }
    );

    test(
      "date-fns typechecks successfully",
      async () => {
        const { sandbox } = getSandbox();

        await sandbox.exec("sandlot install date-fns@4.1.0");

        sandbox.writeFile(
          "/test-datefns-types.ts",
          `import { format, addDays, differenceInDays, parseISO } from 'date-fns';

// Test date formatting
const now = new Date();
const formatted: string = format(now, 'yyyy-MM-dd');

// Test date arithmetic
const tomorrow: Date = addDays(now, 1);
const diff: number = differenceInDays(tomorrow, now);

// Test parsing
const parsed: Date = parseISO('2024-01-15');

console.log('formatted:', formatted);
console.log('diff:', diff);

export function main() {
  return formatted;
}`
        );

        const typecheckResult = await sandbox.typecheck({
          entryPoint: "/test-datefns-types.ts",
        });

        expect(typecheckResult.success).toBe(true);
      },
      { timeout: 30000 }
    );

    test(
      "uuid typechecks successfully",
      async () => {
        const { sandbox } = getSandbox();

        await sandbox.exec("sandlot install uuid@11.1.0");

        sandbox.writeFile(
          "/test-uuid-types.ts",
          `import { v4 as uuidv4, validate, version } from 'uuid';

// Test UUID generation
const id: string = uuidv4();

// Test validation
const isValid: boolean = validate(id);

// Test version detection
const ver: number = version(id);

console.log('uuid:', id);
console.log('valid:', isValid);
console.log('version:', ver);

export function main() {
  return id;
}`
        );

        const typecheckResult = await sandbox.typecheck({
          entryPoint: "/test-uuid-types.ts",
        });

        expect(typecheckResult.success).toBe(true);
      },
      { timeout: 30000 }
    );
  });
});
