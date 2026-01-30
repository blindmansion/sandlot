/**
 * Integration tests for JSX type resolution with React shared modules.
 * 
 * This tests the scenario where:
 * - React is provided as a shared module (not installed from npm)
 * - TypeScript needs to resolve JSX types (IntrinsicElements, etc.)
 * - The tsconfig uses `jsx: "react-jsx"` (new JSX transform)
 * 
 * The issue: When React is a shared module, we need @types/react for typechecking,
 * but the types must be properly resolved for JSX elements like <div>, <button>, etc.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createNodeSandlot, type Sandlot, type Sandbox } from "sandlot/node";
import React from "react";

describe("JSX types with shared React", () => {
  let sandlot: Sandlot;
  let sandbox: Sandbox;

  beforeAll(async () => {
    sandlot = await createNodeSandlot({
      sharedModules: {
        react: React,
        "react/jsx-runtime": await import("react/jsx-runtime"),
      },
    });
    sandbox = await sandlot.createSandbox({
      initialFiles: {
        "/index.tsx": `import { useState } from 'react';

export function App() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <h1>Counter: {count}</h1>
      <button onClick={() => setCount(c => c + 1)}>
        Increment
      </button>
    </div>
  );
}`,
        "/package.json": JSON.stringify({
          name: "jsx-test",
          main: "index.tsx",
          dependencies: {
            react: "^19.0.0",
          },
        }),
      },
    });
  });

  afterAll(async () => {
    await sandlot.dispose();
  });

  test("JSX component builds successfully with skipTypecheck", async () => {
    const result = await sandbox.build({
      entryPoint: "/index.tsx",
      skipTypecheck: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.code).toContain("useState");
    }
  });

  test("JSX component typechecks - IntrinsicElements should be found", async () => {
    const result = await sandbox.typecheck({
      entryPoint: "/index.tsx",
    });

    // Log errors for debugging
    if (!result.success) {
      console.log("Typecheck errors:", result.diagnostics.map(d => 
        `${d.file}:${d.line}: ${d.message}`
      ).join("\n"));
    }

    // This is the key test - JSX should typecheck correctly
    // If IntrinsicElements isn't found, we'll see errors like:
    // "Property 'div' does not exist on type 'JSX.IntrinsicElements'"
    expect(result.success).toBe(true);
  });

  test("JSX with custom component props typechecks correctly", async () => {
    sandbox.writeFile(
      "/button.tsx",
      `import { ReactNode } from 'react';

interface ButtonProps {
  children: ReactNode;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
}

export function Button({ children, onClick, variant = 'primary' }: ButtonProps) {
  return (
    <button 
      className={\`btn btn-\${variant}\`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// Usage
export function Demo() {
  return (
    <div>
      <Button onClick={() => console.log('clicked')} variant="primary">
        Click me
      </Button>
    </div>
  );
}`
    );

    const result = await sandbox.typecheck({
      entryPoint: "/button.tsx",
    });

    if (!result.success) {
      console.log("Button typecheck errors:", result.diagnostics.map(d => 
        `${d.file}:${d.line}: ${d.message}`
      ).join("\n"));
    }

    expect(result.success).toBe(true);
  });

  test("JSX type errors are caught correctly", async () => {
    sandbox.writeFile(
      "/bad-jsx.tsx",
      `export function BadComponent() {
  // Type error: wrong prop type - src is required on img but we're passing a number
  return <img src={123} alt="test" />;
}`
    );

    const result = await sandbox.typecheck({
      entryPoint: "/bad-jsx.tsx",
    });

    // Should fail due to type error
    expect(result.success).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    
    // The error should be about type mismatch
    const hasTypeError = result.diagnostics.some(d => 
      d.message.includes("Type") || d.message.includes("assignable")
    );
    expect(hasTypeError).toBe(true);
  });
});
