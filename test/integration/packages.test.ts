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

  test("multiple packages (lodash-es + date-fns)", async () => {
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
  });

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

    await sandbox.exec("sandlot install uuid");

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
});
