/**
 * Integration tests for sandbox file operations
 */

import { describe, test, expect } from "bun:test";
import { withSandbox } from "../harness/index.ts";

describe("file operations", () => {
  const getSandbox = withSandbox();

  describe("readFile", () => {
    test("returns content with line numbers", () => {
      const { sandbox } = getSandbox();

      sandbox.writeFile(
        "/test-read.ts",
        `const x = 1;
const y = 2;
const z = 3;
console.log(x + y + z);`
      );

      const content = sandbox.readFile("/test-read.ts");

      expect(content).toContain("1|const x = 1;");
      expect(content).toContain("4|console.log");
    });

    test("with offset", () => {
      const { sandbox } = getSandbox();

      sandbox.writeFile(
        "/test-offset.ts",
        `line 0
line 1
line 2
line 3
line 4
line 5
line 6
line 7
line 8
line 9`
      );

      // Read starting from line 5 (0-indexed)
      const content = sandbox.readFile("/test-offset.ts", { offset: 5 });

      // Should start with line 6 (1-indexed in output)
      expect(content).toContain("6|line 5");
      // Should NOT contain earlier lines
      expect(content).not.toContain("line 0");
      expect(content).not.toContain("line 4");
    });

    test("with limit", () => {
      const { sandbox } = getSandbox();

      sandbox.writeFile(
        "/test-limit.ts",
        `line 0
line 1
line 2
line 3
line 4
line 5`
      );

      // Read only first 3 lines
      const content = sandbox.readFile("/test-limit.ts", { limit: 3 });

      expect(content).toContain("1|line 0");
      expect(content).toContain("3|line 2");
      // Should have exactly 3 lines
      expect(content.split("\n").length).toBe(3);
    });

    test("with offset and limit", () => {
      const { sandbox } = getSandbox();

      sandbox.writeFile(
        "/test-offset-limit.ts",
        `line 0
line 1
line 2
line 3
line 4
line 5
line 6
line 7
line 8
line 9`
      );

      // Read 3 lines starting at offset 3
      const content = sandbox.readFile("/test-offset-limit.ts", {
        offset: 3,
        limit: 3,
      });

      expect(content).toContain("4|line 3");
      expect(content).toContain("6|line 5");
      expect(content.split("\n").length).toBe(3);
    });

    test("line number padding for large files", () => {
      const { sandbox } = getSandbox();

      // Create a 150-line file
      const lines = Array.from({ length: 150 }, (_, i) => `line ${i}`);
      sandbox.writeFile("/test-large.ts", lines.join("\n"));

      // Read lines around line 100
      const content = sandbox.readFile("/test-large.ts", {
        offset: 98,
        limit: 5,
      });

      // Line numbers should be padded correctly (right-aligned)
      expect(content).toContain("99|line 98");
    });

    test("long line truncation at 2000 chars", () => {
      const { sandbox } = getSandbox();

      const longLine = "x".repeat(2500);
      sandbox.writeFile("/test-long-line.ts", longLine);

      const content = sandbox.readFile("/test-long-line.ts");

      // The line should be truncated and end with ...
      expect(content.endsWith("...")).toBe(true);
      // Should be approximately 2000 + line number prefix + ...
      expect(content.length).toBeLessThan(2020);
    });
  });

  describe("readFileRaw", () => {
    test("returns raw content without line numbers", () => {
      const { sandbox } = getSandbox();

      const originalContent = `export const x = 1;
export const y = 2;`;

      sandbox.writeFile("/test-raw.ts", originalContent);

      const rawContent = sandbox.readFileRaw("/test-raw.ts");

      expect(rawContent).toBe(originalContent);
      expect(rawContent).not.toContain("|export");
    });
  });

  describe("editFile", () => {
    test("replaces single occurrence", () => {
      const { sandbox } = getSandbox();

      sandbox.writeFile(
        "/test-edit.ts",
        `const x = 1;
const y = 2;
const z = 3;`
      );

      sandbox.editFile("/test-edit.ts", {
        oldString: "const y = 2;",
        newString: "const y = 42;",
      });

      const content = sandbox.readFileRaw("/test-edit.ts");

      expect(content).toContain("const y = 42;");
      expect(content).not.toContain("const y = 2;");
    });

    test("fails on multiple occurrences without replaceAll", () => {
      const { sandbox } = getSandbox();

      sandbox.writeFile(
        "/test-edit-multi.ts",
        `const x = 1;
const x = 2;
const x = 3;`
      );

      expect(() => {
        sandbox.editFile("/test-edit-multi.ts", {
          oldString: "const x",
          newString: "const y",
        });
      }).toThrow(/found 3 times/);
    });

    test("with replaceAll", () => {
      const { sandbox } = getSandbox();

      sandbox.writeFile(
        "/test-edit-all.ts",
        `const TODO = 'task 1';
const TODO2 = 'task 2';
// TODO: fix this
`
      );

      sandbox.editFile("/test-edit-all.ts", {
        oldString: "TODO",
        newString: "DONE",
        replaceAll: true,
      });

      const content = sandbox.readFileRaw("/test-edit-all.ts");

      expect(content).not.toContain("TODO");
      expect(content).toContain("DONE");
      expect(content).toContain("DONE2");
    });

    test("fails if oldString not found", () => {
      const { sandbox } = getSandbox();

      sandbox.writeFile("/test-edit-notfound.ts", `const x = 1;`);

      expect(() => {
        sandbox.editFile("/test-edit-notfound.ts", {
          oldString: "nonexistent string",
          newString: "replacement",
        });
      }).toThrow(/not found/);
    });

    test("fails if oldString equals newString", () => {
      const { sandbox } = getSandbox();

      sandbox.writeFile("/test-edit-same.ts", `const x = 1;`);

      expect(() => {
        sandbox.editFile("/test-edit-same.ts", {
          oldString: "const x = 1;",
          newString: "const x = 1;",
        });
      }).toThrow(/must be different/);
    });

    test("with multi-line replacement", () => {
      const { sandbox } = getSandbox();

      sandbox.writeFile(
        "/test-edit-multiline.ts",
        `function greet() {
  console.log("hello");
}

greet();`
      );

      sandbox.editFile("/test-edit-multiline.ts", {
        oldString: `function greet() {
  console.log("hello");
}`,
        newString: `function greet(name: string) {
  console.log(\`Hello, \${name}!\`);
  return name;
}`,
      });

      const content = sandbox.readFileRaw("/test-edit-multiline.ts");

      expect(content).toContain("name: string");
      expect(content).toContain("return name;");
    });
  });
});
