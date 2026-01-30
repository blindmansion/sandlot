/**
 * Integration tests for zustand package - installation and typechecking
 *
 * Tests both runtime behavior and type resolution for zustand, including:
 * - Vanilla (non-React) zustand stores
 * - React zustand stores with the `create` hook
 * - Subpath imports like `zustand/vanilla`
 * 
 * NOTE: esm.sh rewrites relative imports to absolute URLs in newer zustand versions
 * (5.0.5+). The EsmTypesResolver handles this by:
 * 1. Following absolute esm.sh URLs when parsing type files
 * 2. Rewriting absolute URLs back to relative paths when storing
 */

import { describe, test, expect } from "bun:test";
import { withSandbox } from "../harness/index.ts";

describe("zustand package", () => {
  const getSandbox = withSandbox();

  describe("runtime behavior", () => {
    test("vanilla zustand store works at runtime (skipTypecheck=true)", async () => {
      const { sandbox } = getSandbox();

      // Use specific version to ensure consistency
      await sandbox.exec("sandlot install zustand@5.0.10");

      sandbox.writeFile(
        "/test-zustand-vanilla.ts",
        `import { createStore } from 'zustand/vanilla';

interface CounterState {
  count: number;
  increment: () => void;
  decrement: () => void;
}

const store = createStore<CounterState>((set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
  decrement: () => set((state) => ({ count: state.count - 1 })),
}));

console.log('initial:', store.getState().count);
store.getState().increment();
console.log('after increment:', store.getState().count);
store.getState().increment();
console.log('after 2nd increment:', store.getState().count);
store.getState().decrement();
console.log('after decrement:', store.getState().count);

export function main() {
  return store.getState().count;
}`
      );

      const result = await sandbox.run({
        entryPoint: "/test-zustand-vanilla.ts",
        skipTypecheck: true,
      });

      expect(result.success).toBe(true);
      expect(result.logs.join("\n")).toContain("initial: 0");
      expect(result.logs.join("\n")).toContain("after increment: 1");
      expect(result.logs.join("\n")).toContain("after 2nd increment: 2");
      expect(result.logs.join("\n")).toContain("after decrement: 1");
      expect(result.returnValue).toBe(1);
    });

    test("React zustand store (create) works at runtime (skipTypecheck=true)", async () => {
      const { sandbox } = getSandbox();

      sandbox.writeFile(
        "/test-zustand-react.ts",
        `import { create } from 'zustand';

interface BearState {
  bears: number;
  increase: () => void;
}

const useBearStore = create<BearState>((set) => ({
  bears: 0,
  increase: () => set((state) => ({ bears: state.bears + 1 })),
}));

console.log('store type:', typeof useBearStore);
console.log('store is function:', typeof useBearStore === 'function');

export function main() {
  return typeof useBearStore;
}`
      );

      const result = await sandbox.run({
        entryPoint: "/test-zustand-react.ts",
        skipTypecheck: true,
      });

      expect(result.success).toBe(true);
      expect(result.logs.join("\n")).toContain("store type: function");
      expect(result.returnValue).toBe("function");
    });

    test("zustand build succeeds with skipTypecheck=true", async () => {
      const { sandbox } = getSandbox();

      sandbox.writeFile(
        "/zustand-component.tsx",
        `import { create } from 'zustand';

interface CounterState {
  count: number;
  increment: () => void;
  decrement: () => void;
  reset: () => void;
}

const useCounterStore = create<CounterState>((set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
  decrement: () => set((state) => ({ count: state.count - 1 })),
  reset: () => set({ count: 0 }),
}));

export function Counter() {
  const { count, increment, decrement, reset } = useCounterStore();
  
  return (
    <div>
      <h2>Count: {count}</h2>
      <button onClick={increment}>+</button>
      <button onClick={decrement}>-</button>
      <button onClick={reset}>Reset</button>
    </div>
  );
}

console.log('Component defined');`
      );

      const buildResult = await sandbox.build({
        entryPoint: "/zustand-component.tsx",
        skipTypecheck: true,
      });

      expect(buildResult.success).toBe(true);
      if (buildResult.success) {
        expect(buildResult.code.length).toBeGreaterThan(1000);
        // The bundle should contain zustand code
        expect(
          buildResult.code.includes("create") || 
          buildResult.code.includes("createStore")
        ).toBe(true);
      }
    });
  });

  describe("typechecking", () => {
    test("zustand create() typechecks successfully", async () => {
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install zustand@5.0.10");

      sandbox.writeFile(
        "/test-zustand-types.ts",
        `import { create } from 'zustand';

interface CounterState {
  count: number;
  increment: () => void;
}

const useCounter = create<CounterState>((set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
}));

console.log('created store');

export function main() {
  return typeof useCounter;
}`
      );

      const typecheckResult = await sandbox.typecheck({
        entryPoint: "/test-zustand-types.ts",
      });

      expect(typecheckResult.success).toBe(true);
    });

    test("zustand/vanilla subpath typechecks successfully", async () => {
      const { sandbox } = getSandbox();

      // Install both the main package and the subpath
      await sandbox.exec("sandlot install zustand@5.0.10");
      await sandbox.exec("sandlot install zustand@5.0.10/vanilla");

      sandbox.writeFile(
        "/test-zustand-vanilla-types.ts",
        `import { createStore } from 'zustand/vanilla';

interface State {
  count: number;
}

const store = createStore<State>(() => ({ count: 0 }));
console.log(store.getState().count);

export function main() {
  return store.getState().count;
}`
      );

      const typecheckResult = await sandbox.typecheck({
        entryPoint: "/test-zustand-vanilla-types.ts",
      });

      expect(typecheckResult.success).toBe(true);
    });

    test("zustand without explicit types fails (expected - zustand requires type annotations)", async () => {
      // This test documents that zustand's Create type REQUIRES explicit type parameters.
      // This is by design in zustand - there's no overload that infers T from the callback.
      // Both native TypeScript and the sandbox exhibit this behavior.
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install zustand@5.0.10");

      sandbox.writeFile(
        "/test-zustand-no-types.ts",
        `import { create } from 'zustand';

// No interface, no type parameter - rely on inference (THIS FAILS)
const useCounterStore = create((set) => ({
  count: 0,
  increment: () => set((state) => ({ count: state.count + 1 })),
  decrement: () => set((state) => ({ count: state.count - 1 })),
  reset: () => set({ count: 0 }),
}));

// This fails because zustand can't infer the state type
const { count, increment } = useCounterStore.getState();
console.log('count:', count);

export function main() {
  return count;
}`
      );

      const typecheckResult = await sandbox.typecheck({
        entryPoint: "/test-zustand-no-types.ts",
      });

      // Expected to fail - zustand requires explicit type annotations
      expect(typecheckResult.success).toBe(false);
      expect(typecheckResult.diagnostics.length).toBeGreaterThan(0);
      
      // Should have errors about implicit any or unknown types
      const hasExpectedErrors = typecheckResult.diagnostics.some(
        (d) =>
          d.message.includes("implicitly has an 'any' type") ||
          d.message.includes("does not exist on type")
      );
      expect(hasExpectedErrors).toBe(true);
    });

    test("zustand with full type inference", async () => {
      const { sandbox } = getSandbox();

      await sandbox.exec("sandlot install zustand@5.0.10");

      sandbox.writeFile(
        "/test-zustand-infer.ts",
        `import { create } from 'zustand';

// Define a store with typed state
interface BearState {
  bears: number;
  fish: number;
  addBear: () => void;
  eatFish: () => void;
  removeAllBears: () => void;
}

const useBearStore = create<BearState>((set) => ({
  bears: 0,
  fish: 10,
  addBear: () => set((state) => ({ bears: state.bears + 1 })),
  eatFish: () => set((state) => ({ fish: state.fish - 1 })),
  removeAllBears: () => set({ bears: 0 }),
}));

// Type should be inferred correctly
type State = ReturnType<typeof useBearStore.getState>;

const testState: State = {
  bears: 5,
  fish: 3,
  addBear: () => {},
  eatFish: () => {},
  removeAllBears: () => {},
};

console.log('bears:', testState.bears);

export function main() {
  return testState.bears;
}`
      );

      const typecheckResult = await sandbox.typecheck({
        entryPoint: "/test-zustand-infer.ts",
      });

      expect(typecheckResult.success).toBe(true);
    });
  });
});
