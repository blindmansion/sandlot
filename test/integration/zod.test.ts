/**
 * Integration tests for zod package - installation and typechecking
 *
 * Tests both runtime behavior and type resolution to identify
 * any issues with our type setup for this commonly-used package.
 */

import { describe, test, expect } from "bun:test";
import { withSandbox } from "../harness/index.ts";

describe("zod package", () => {
  const getSandbox = withSandbox();

  describe("installation and runtime", () => {
    test("installs zod and runs basic schema", async () => {
      const { sandbox } = getSandbox();

      // Install zod
      await sandbox.exec("sandlot install zod");

      sandbox.writeFile(
        "/test-zod.ts",
        `import { z } from 'zod';

const userSchema = z.object({
  name: z.string(),
  age: z.number().min(0),
  email: z.string().email(),
});

const validUser = { name: "Alice", age: 30, email: "alice@example.com" };
const result = userSchema.safeParse(validUser);

console.log('success:', result.success);
if (result.success) {
  console.log('name:', result.data.name);
  console.log('age:', result.data.age);
}

export function main() {
  return result;
}`
      );

      const result = await sandbox.run({
        entryPoint: "/test-zod.ts",
        skipTypecheck: true,
      });

      expect(result.success).toBe(true);
      expect(result.logs.join("\n")).toContain("success: true");
      expect(result.logs.join("\n")).toContain("name: Alice");
    });

    test("zod validation failures work correctly", async () => {
      const { sandbox } = getSandbox();

      // Use correct zod API - issues array is on error object
      sandbox.writeFile(
        "/test-zod-fail.ts",
        `import { z } from 'zod';

const schema = z.string().email();
const result = schema.safeParse("not-an-email");

console.log('success:', result.success);
if (!result.success) {
  // zod 3.x uses .issues, not .errors
  console.log('error count:', result.error.issues.length);
  console.log('first error:', result.error.issues[0].message);
}

export function main() {
  return { success: result.success };
}`
      );

      const result = await sandbox.run({
        entryPoint: "/test-zod-fail.ts",
        skipTypecheck: true,
      });

      expect(result.success).toBe(true);
      expect(result.logs.join("\n")).toContain("success: false");
      expect(result.logs.join("\n")).toContain("error count: 1");
    });
  });

  describe("typechecking", () => {
    test("typechecks basic zod usage", async () => {
      const { sandbox } = getSandbox();

      // Ensure zod is installed (may already be from previous tests)
      await sandbox.exec("sandlot install zod");

      sandbox.writeFile(
        "/test-zod-types.ts",
        `import { z } from 'zod';

const schema = z.object({
  id: z.number(),
  name: z.string(),
});

// Type inference should work
type User = z.infer<typeof schema>;

const user: User = {
  id: 1,
  name: "Test",
};

console.log('user:', user);

export function main() {
  return user;
}`
      );

      const typecheckResult = await sandbox.typecheck({
        entryPoint: "/test-zod-types.ts",
      });

      expect(typecheckResult.success).toBe(true);
    });

    test("typechecks zod with skipTypecheck=false in run()", async () => {
      const { sandbox } = getSandbox();

      sandbox.writeFile(
        "/test-zod-full.ts",
        `import { z } from 'zod';

const personSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  age: z.number().positive(),
});

type Person = z.infer<typeof personSchema>;

function greet(person: Person): string {
  return \`Hello, \${person.firstName} \${person.lastName}! You are \${person.age} years old.\`;
}

const person = personSchema.parse({
  firstName: "John",
  lastName: "Doe",
  age: 25,
});

console.log(greet(person));

export function main() {
  return person;
}`
      );

      const result = await sandbox.run({
        entryPoint: "/test-zod-full.ts",
        skipTypecheck: false,
      });

      expect(result.success).toBe(true);
      expect(result.logs.join("\n")).toContain("Hello, John Doe!");
    });

    test("catches type errors with zod", async () => {
      const { sandbox } = getSandbox();

      // Ensure zod is installed
      await sandbox.exec("sandlot install zod");

      sandbox.writeFile(
        "/test-zod-type-error.ts",
        `import { z } from 'zod';

const schema = z.object({
  name: z.string(),
  count: z.number(),
});

type MyType = z.infer<typeof schema>;

// This should be a type error - wrong property type
const bad: MyType = {
  name: "test",
  count: "not a number", // Should be number
};

export function main() {
  return bad;
}`
      );

      const typecheckResult = await sandbox.typecheck({
        entryPoint: "/test-zod-type-error.ts",
      });

      // This should fail because count should be a number
      expect(typecheckResult.success).toBe(false);
      expect(typecheckResult.diagnostics.length).toBeGreaterThan(0);
    });

    test("zod z.infer produces correct types", async () => {
      const { sandbox } = getSandbox();

      sandbox.writeFile(
        "/test-zod-infer.ts",
        `import { z } from 'zod';

// Complex nested schema
const addressSchema = z.object({
  street: z.string(),
  city: z.string(),
  zip: z.string(),
});

const userSchema = z.object({
  id: z.number(),
  email: z.string().email(),
  address: addressSchema.optional(),
  tags: z.array(z.string()),
});

type User = z.infer<typeof userSchema>;

// This should typecheck correctly
const user: User = {
  id: 1,
  email: "test@example.com",
  tags: ["admin", "user"],
};

// Access nested optional type safely
if (user.address) {
  console.log('city:', user.address.city);
}

console.log('user id:', user.id);
console.log('tags:', user.tags.join(', '));

export function main() {
  return user;
}`
      );

      const result = await sandbox.run({
        entryPoint: "/test-zod-infer.ts",
        skipTypecheck: false,
      });

      expect(result.success).toBe(true);
    });
  });
});
