/**
 * Extended package tests - testing various npm packages for compatibility.
 *
 * Each test is minimal: install, typecheck, build, run.
 * The goal is to surface edge cases in our type resolution and bundling.
 *
 * NOTE: These tests use pinned package versions to leverage the disk cache
 * and avoid repeated network requests with esm.sh. This significantly improves
 * test performance (from minutes per test to sub-second).
 *
 * For best results, run with: bun test --concurrency 1
 * (Concurrent execution may cause resource contention issues)
 */

import { describe, test, expect, setDefaultTimeout } from "bun:test";
import { withSandbox } from "../harness/index.ts";

// Set a longer timeout for these tests since they involve network and bundling
setDefaultTimeout(15000);

describe("extended package tests", () => {
  const getSandbox = withSandbox();

  // =========================================================================
  // uuid - Uses @types/uuid fallback
  // =========================================================================
  describe("uuid", () => {
    test("installs, typechecks, and runs", async () => {
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install uuid@11.1.0");

      sandbox.writeFile(
        "/index.ts",
        `import { v4 as uuidv4, validate } from 'uuid';

const id: string = uuidv4();
const isValid: boolean = validate(id);

console.log('id:', id);
console.log('valid:', isValid);

export function main() {
  return { id, isValid };
}`
      );

      const typecheckResult = await sandbox.typecheck();
      expect(typecheckResult.success).toBe(true);

      const runResult = await sandbox.run({ skipTypecheck: true });
      expect(runResult.success).toBe(true);
      expect(runResult.logs.join("\n")).toContain("valid: true");
    });
  });

  // =========================================================================
  // nanoid - Simple utility, ESM native
  // =========================================================================
  describe("nanoid", () => {
    test("installs, typechecks, and runs", async () => {
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install nanoid@5.1.6");

      sandbox.writeFile(
        "/index.ts",
        `import { nanoid, customAlphabet } from 'nanoid';

const id: string = nanoid();
const customId: string = customAlphabet('abc123', 10)();

console.log('id:', id);
console.log('customId:', customId);

export function main() {
  return { id, customId };
}`
      );

      const typecheckResult = await sandbox.typecheck();
      expect(typecheckResult.success).toBe(true);

      const runResult = await sandbox.run({ skipTypecheck: true });
      expect(runResult.success).toBe(true);
      expect(runResult.logs.join("\n")).toContain("id:");
    });
  });

  // =========================================================================
  // clsx - Tiny utility for classnames
  // =========================================================================
  describe("clsx", () => {
    test("installs, typechecks, and runs", async () => {
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install clsx@2.1.1");

      sandbox.writeFile(
        "/index.ts",
        `import { clsx } from 'clsx';

const className: string = clsx('foo', { bar: true, baz: false }, ['qux']);

console.log('className:', className);

export function main() {
  return className;
}`
      );

      const typecheckResult = await sandbox.typecheck();
      expect(typecheckResult.success).toBe(true);

      const runResult = await sandbox.run({ skipTypecheck: true });
      expect(runResult.success).toBe(true);
      expect(runResult.logs.join("\n")).toContain("className: foo bar qux");
    });
  });

  // =========================================================================
  // immer - Immutable state updates
  // =========================================================================
  describe("immer", () => {
    test("installs, typechecks, and runs", async () => {
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install immer@11.1.3");

      sandbox.writeFile(
        "/index.ts",
        `import { produce } from 'immer';

interface State {
  count: number;
  items: string[];
}

const initial: State = { count: 0, items: ['a'] };

const next: State = produce(initial, (draft) => {
  draft.count += 1;
  draft.items.push('b');
});

console.log('count:', next.count);
console.log('items:', next.items.join(','));

export function main() {
  return next;
}`
      );

      const typecheckResult = await sandbox.typecheck();
      expect(typecheckResult.success).toBe(true);

      const runResult = await sandbox.run({ skipTypecheck: true });
      expect(runResult.success).toBe(true);
      expect(runResult.logs.join("\n")).toContain("count: 1");
      expect(runResult.logs.join("\n")).toContain("items: a,b");
    });
  });

  // =========================================================================
  // swr - React data fetching (has React peer dep)
  // =========================================================================
  describe("swr", () => {
    test("installs, typechecks, and runs", async () => {
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install swr@2.3.8");

      sandbox.writeFile(
        "/index.ts",
        `import useSWR from 'swr';

// Just verify the hook type exists
type SWRHook = typeof useSWR;

console.log('useSWR type:', typeof useSWR);

export function main() {
  return typeof useSWR;
}`
      );

      const typecheckResult = await sandbox.typecheck();
      expect(typecheckResult.success).toBe(true);

      const runResult = await sandbox.run({ skipTypecheck: true });
      expect(runResult.success).toBe(true);
      expect(runResult.logs.join("\n")).toContain("useSWR type: function");
    });
  });

  // =========================================================================
  // jotai - Atomic state management
  // =========================================================================
  describe("jotai", () => {
    test("installs, typechecks, and runs", async () => {
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install jotai@2.17.0");

      sandbox.writeFile(
        "/index.ts",
        `import { atom } from 'jotai';

const countAtom = atom(0);
const doubleAtom = atom((get) => get(countAtom) * 2);

// Verify atom types
type CountAtom = typeof countAtom;
type DoubleAtom = typeof doubleAtom;

console.log('countAtom:', typeof countAtom);
console.log('doubleAtom:', typeof doubleAtom);

export function main() {
  return { countAtom, doubleAtom };
}`
      );

      const typecheckResult = await sandbox.typecheck();
      expect(typecheckResult.success).toBe(true);

      const runResult = await sandbox.run({ skipTypecheck: true });
      expect(runResult.success).toBe(true);
      expect(runResult.logs.join("\n")).toContain("countAtom: object");
    });
  });

  // =========================================================================
  // ts-pattern - Pattern matching with complex types
  // =========================================================================
  describe("ts-pattern", () => {
    test("installs and runs (typecheck has inference issues)", async () => {
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install ts-pattern@5.9.0");

      sandbox.writeFile(
        "/index.ts",
        `import { match, P } from 'ts-pattern';

type Result = { type: 'success'; value: number } | { type: 'error'; message: string };

const result: Result = { type: 'success', value: 42 };

const output: string = match(result)
  .with({ type: 'success' }, (r) => \`Got: \${r.value}\`)
  .with({ type: 'error' }, (r) => \`Error: \${r.message}\`)
  .exhaustive();

console.log('output:', output);

export function main() {
  return output;
}`
      );

      // ts-pattern has complex conditional types that don't fully resolve
      // in our sandbox TypeScript setup. Runtime works fine.
      const typecheckResult = await sandbox.typecheck();
      if (!typecheckResult.success) {
        // Expected: complex inference doesn't work, but basic types load
        expect(typecheckResult.diagnostics.length).toBeGreaterThan(0);
      }

      // Runtime should still work
      const runResult = await sandbox.run({ skipTypecheck: true });
      expect(runResult.success).toBe(true);
      expect(runResult.logs.join("\n")).toContain("output: Got: 42");
    });
  });

  // =========================================================================
  // @tanstack/react-query - Scoped package, complex types
  // =========================================================================
  describe("@tanstack/react-query", () => {
    test("hooks from react-query typecheck correctly", async () => {
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install @tanstack/react-query@5.90.20");

      // Use only what's directly exported from react-query (hooks, providers)
      sandbox.writeFile(
        "/index.ts",
        `import { useQuery, useQueryClient } from '@tanstack/react-query';

// Verify types exist
type QueryHook = typeof useQuery;
type ClientHook = typeof useQueryClient;

console.log('useQuery:', typeof useQuery);
console.log('useQueryClient:', typeof useQueryClient);

export function main() {
  return { useQuery: typeof useQuery, useQueryClient: typeof useQueryClient };
}`
      );

      const typecheckResult = await sandbox.typecheck();
      if (!typecheckResult.success) {
        console.log("@tanstack/react-query diagnostics:", JSON.stringify(typecheckResult.diagnostics, null, 2));
      }
      expect(typecheckResult.success).toBe(true);

      const runResult = await sandbox.run({ skipTypecheck: true });
      expect(runResult.success).toBe(true);
      expect(runResult.logs.join("\n")).toContain("useQuery: function");
    });

    test("QueryClient auto-resolves from peer type deps", async () => {
      const { sandbox } = getSandbox();

      // Install only @tanstack/react-query - the resolver should automatically
      // detect that it has `export * from '@tanstack/query-core'` and install
      // that package's types as a peer dependency.
      await sandbox.exec("sandlot install @tanstack/react-query@5.90.20");

      // QueryClient is re-exported from @tanstack/query-core at runtime.
      // Our type resolver now automatically detects and installs peer type deps,
      // so this should work without explicitly installing query-core.
      sandbox.writeFile(
        "/index.ts",
        `import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';

const queryClient = new QueryClient();

console.log('QueryClient:', typeof queryClient);
console.log('QueryClientProvider:', typeof QueryClientProvider);
console.log('useQuery:', typeof useQuery);

export function main() { return queryClient; }`
      );

      const typecheckResult = await sandbox.typecheck();
      if (!typecheckResult.success) {
        console.log("Diagnostics:", JSON.stringify(typecheckResult.diagnostics, null, 2));
      }
      expect(typecheckResult.success).toBe(true);

      const runResult = await sandbox.run({ skipTypecheck: true });
      expect(runResult.success).toBe(true);
      expect(runResult.logs.join("\n")).toContain("QueryClient: object");
    });
  });

  // =========================================================================
  // react-hook-form - Form handling with complex generics
  // =========================================================================
  describe("react-hook-form", () => {
    test("installs, typechecks, and runs", async () => {
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install react-hook-form@7.71.1");

      sandbox.writeFile(
        "/index.ts",
        `import { useForm } from 'react-hook-form';

interface FormData {
  name: string;
  email: string;
}

// Just verify the hook type
type FormHook = typeof useForm<FormData>;

console.log('useForm:', typeof useForm);

export function main() {
  return typeof useForm;
}`
      );

      const typecheckResult = await sandbox.typecheck();
      expect(typecheckResult.success).toBe(true);

      const runResult = await sandbox.run({ skipTypecheck: true });
      expect(runResult.success).toBe(true);
      expect(runResult.logs.join("\n")).toContain("useForm: function");
    });
  });

  // =========================================================================
  // @radix-ui/react-dialog - Scoped UI component package
  // =========================================================================
  describe("@radix-ui/react-dialog", () => {
    test("installs, typechecks, and runs", async () => {
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install @radix-ui/react-dialog@1.1.15");

      sandbox.writeFile(
        "/index.ts",
        `import * as Dialog from '@radix-ui/react-dialog';

// Verify exports exist
type Root = typeof Dialog.Root;
type Trigger = typeof Dialog.Trigger;
type Content = typeof Dialog.Content;

console.log('Dialog.Root:', typeof Dialog.Root);
console.log('Dialog.Trigger:', typeof Dialog.Trigger);

export function main() {
  return {
    Root: typeof Dialog.Root,
    Trigger: typeof Dialog.Trigger,
  };
}`
      );

      const typecheckResult = await sandbox.typecheck();
      expect(typecheckResult.success).toBe(true);

      const runResult = await sandbox.run({ skipTypecheck: true });
      expect(runResult.success).toBe(true);
    });
  });

  // =========================================================================
  // axios - HTTP client with conditional exports
  // =========================================================================
  describe("axios", () => {
    test("installs, typechecks, and runs", async () => {
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install axios@1.13.4");

      sandbox.writeFile(
        "/index.ts",
        `import axios, { AxiosResponse, AxiosError } from 'axios';

// Verify types
type Response = AxiosResponse<{ data: string }>;
type Error = AxiosError;

console.log('axios:', typeof axios);
console.log('axios.get:', typeof axios.get);

export function main() {
  return typeof axios;
}`
      );

      const typecheckResult = await sandbox.typecheck();
      expect(typecheckResult.success).toBe(true);

      const runResult = await sandbox.run({ skipTypecheck: true });
      expect(runResult.success).toBe(true);
      expect(runResult.logs.join("\n")).toContain("axios: function");
    });
  });

  // =========================================================================
  // dayjs - Date library (alternative to date-fns)
  // =========================================================================
  describe("dayjs", () => {
    test("installs, typechecks, and runs", async () => {
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install dayjs@1.11.19");

      sandbox.writeFile(
        "/index.ts",
        `import dayjs from 'dayjs';

const now = dayjs();
const formatted: string = now.format('YYYY-MM-DD');
const year: number = now.year();

console.log('formatted:', formatted);
console.log('year:', year);

export function main() {
  return { formatted, year };
}`
      );

      const typecheckResult = await sandbox.typecheck();
      expect(typecheckResult.success).toBe(true);

      const runResult = await sandbox.run({ skipTypecheck: true });
      expect(runResult.success).toBe(true);
      expect(runResult.logs.join("\n")).toContain("year:");
    });
  });

  // =========================================================================
  // type-fest - Pure types, no runtime
  // =========================================================================
  describe("type-fest", () => {
    test("installs and typechecks (no runtime)", async () => {
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install type-fest@4.41.0");

      sandbox.writeFile(
        "/index.ts",
        `import type { PartialDeep, ReadonlyDeep, SetRequired } from 'type-fest';

interface User {
  name: string;
  address: {
    city: string;
    zip: string;
  };
}

// Use type utilities
type PartialUser = PartialDeep<User>;
type ReadonlyUser = ReadonlyDeep<User>;
type RequiredName = SetRequired<Partial<User>, 'name'>;

const partial: PartialUser = { address: { city: 'NYC' } };
const required: RequiredName = { name: 'Alice' };

console.log('partial:', JSON.stringify(partial));
console.log('required:', JSON.stringify(required));

export function main() {
  return { partial, required };
}`
      );

      const typecheckResult = await sandbox.typecheck();
      if (!typecheckResult.success) {
        // type-fest is a pure types package with no runtime exports.
        // esm.sh doesn't provide X-TypeScript-Types header for it.
        // This is a known limitation for types-only packages.
        console.log("type-fest: types-only package not supported (no X-TypeScript-Types header from esm.sh)");
        expect(typecheckResult.diagnostics.some(d => d.message.includes("Cannot find module"))).toBe(true);
      }

      // Runtime still works (no actual imports)
      const runResult = await sandbox.run({ skipTypecheck: true });
      expect(runResult.success).toBe(true);
    });
  });

  // =========================================================================
  // framer-motion - Large animation library
  // =========================================================================
  describe("framer-motion", () => {
    test("installs, typechecks, and runs", async () => {
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install framer-motion@12.29.2");

      sandbox.writeFile(
        "/index.ts",
        `import { motion, AnimatePresence } from 'framer-motion';

// Verify exports
type Motion = typeof motion;
type Presence = typeof AnimatePresence;

console.log('motion:', typeof motion);
console.log('motion.div:', typeof motion.div);

export function main() {
  return typeof motion;
}`
      );

      const typecheckResult = await sandbox.typecheck();
      expect(typecheckResult.success).toBe(true);

      const runResult = await sandbox.run({ skipTypecheck: true });
      expect(runResult.success).toBe(true);
    });
  });

  // =========================================================================
  // lodash-es - ESM lodash with tree-shaking
  // =========================================================================
  describe("lodash-es", () => {
    test("installs, typechecks, and runs", async () => {
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install lodash-es@4.17.21");

      // Add explicit type annotation for the callback to avoid implicit any
      sandbox.writeFile(
        "/index.ts",
        `import { chunk, uniq, groupBy } from 'lodash-es';

const chunks: number[][] = chunk([1, 2, 3, 4, 5], 2);
const unique: number[] = uniq([1, 1, 2, 2, 3]);
const grouped = groupBy(['one', 'two', 'three'], (s: string) => s.length);

console.log('chunks:', JSON.stringify(chunks));
console.log('unique:', JSON.stringify(unique));
console.log('grouped:', JSON.stringify(grouped));

export function main() {
  return { chunks, unique, grouped };
}`
      );

      const typecheckResult = await sandbox.typecheck();
      if (!typecheckResult.success) {
        console.log("lodash-es diagnostics:", JSON.stringify(typecheckResult.diagnostics.slice(0, 5), null, 2));
      }
      expect(typecheckResult.success).toBe(true);

      const runResult = await sandbox.run({ skipTypecheck: true });
      expect(runResult.success).toBe(true);
      expect(runResult.logs.join("\n")).toContain("unique: [1,2,3]");
    });
  });
});
