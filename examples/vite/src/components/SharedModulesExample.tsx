import { useState, useEffect, useRef } from "react";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ReactDOM from "react-dom/client";
import type { Sandlot, Diagnostic, BundleError } from "sandlot";
import { createBrowserSandlot } from "sandlot/browser";

// Format type check diagnostics for display
function formatDiagnostics(diagnostics: Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      const loc =
        d.file && d.line
          ? `${d.file}:${d.line}${d.column ? `:${d.column}` : ""}`
          : "";
      const prefix =
        d.severity === "error"
          ? "error"
          : d.severity === "warning"
            ? "warning"
            : "info";
      return loc
        ? `${loc} - ${prefix}: ${d.message}`
        : `${prefix}: ${d.message}`;
    })
    .join("\n");
}

// Format bundle errors for display
function formatBundleErrors(errors: BundleError[]): string {
  return errors
    .map((e) => {
      if (e.location) {
        const loc = `${e.location.file}:${e.location.line}${e.location.column ? `:${e.location.column}` : ""}`;
        let msg = `${loc}: ${e.text}`;
        if (e.location.lineText) {
          msg += `\n    ${e.location.lineText}`;
        }
        return msg;
      }
      return e.text;
    })
    .join("\n\n");
}

export function SharedModulesExample() {
  const [code, setCode] =
    useState(`// Testing Tailwind CSS support!
// The bundler scans for Tailwind classes and generates CSS.

import { useState } from 'react';

export function MyComponent() {
  const [count, setCount] = useState(0);
  
  return (
    <div className="p-6 bg-gradient-to-br from-purple-500 to-pink-500 rounded-xl text-white font-sans text-center shadow-lg">
      <h3 className="text-xl font-bold mb-4">Tailwind CSS Test</h3>
      <p className="mb-4 text-purple-100">
        If you see a purple-pink gradient with rounded corners - Tailwind works!
      </p>
      <div className="flex items-center justify-center gap-4">
        <button
          className="px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg text-lg font-bold transition-all"
          onClick={() => setCount((c) => c - 1)}
        >
          -
        </button>
        <span className="text-3xl font-bold min-w-[60px]">{count}</span>
        <button
          className="px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg text-lg font-bold transition-all"
          onClick={() => setCount((c) => c + 1)}
        >
          +
        </button>
      </div>
    </div>
  );
}
`);
  const [output, setOutput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const sandlotRef = useRef<Sandlot | null>(null);
  const renderContainerRef = useRef<HTMLDivElement | null>(null);
  const reactRootRef = useRef<ReactDOM.Root | null>(null);

  // Initialize sandlot with shared modules once on mount
  useEffect(() => {
    createBrowserSandlot({
      sharedModules: {
        react: React,
        "react/jsx-runtime": jsxRuntime,
        "react-dom/client": ReactDOM,
      },
    }).then((sandlot) => {
      sandlotRef.current = sandlot;
    });
  }, []);

  // Cleanup React root on unmount
  useEffect(() => {
    return () => {
      if (reactRootRef.current) {
        reactRootRef.current.unmount();
      }
    };
  }, []);

  const runCode = async () => {
    setIsRunning(true);
    setOutput("");

    // Unmount previous React root BEFORE clearing DOM
    // (React must clean up its nodes before we remove them)
    if (reactRootRef.current) {
      reactRootRef.current.unmount();
      reactRootRef.current = null;
    }

    try {
      // Ensure sandlot is initialized with shared modules
      if (!sandlotRef.current) {
        sandlotRef.current = await createBrowserSandlot({
          sharedModules: {
            react: React,
            "react/jsx-runtime": jsxRuntime,
            "react-dom/client": ReactDOM,
          },
        });
      }

      // Create a fresh sandbox for each build
      const sandbox = await sandlotRef.current.createSandbox();

      // Write the code to the sandbox
      sandbox.writeFile("/index.tsx", code);

      // Build with Tailwind CSS enabled
      const buildResult = await sandbox.build({
        entryPoint: "/index.tsx",
        tailwind: true,
      });

      if (!buildResult.success) {
        // Format detailed error based on which phase failed
        let errorOutput = `Build failed in ${buildResult.phase} phase:\n\n`;

        switch (buildResult.phase) {
          case "entry":
            errorOutput += buildResult.message ?? "Entry point not found";
            break;
          case "typecheck":
            if (buildResult.diagnostics && buildResult.diagnostics.length > 0) {
              errorOutput += formatDiagnostics(buildResult.diagnostics);
            } else {
              errorOutput += "Type check failed (no details available)";
            }
            break;
          case "bundle":
            if (
              buildResult.bundleErrors &&
              buildResult.bundleErrors.length > 0
            ) {
              errorOutput += formatBundleErrors(buildResult.bundleErrors);
            } else {
              errorOutput += "Bundle failed (no details available)";
            }
            break;
        }

        setOutput(errorOutput);
        return;
      }

      // Build succeeded - load the module directly and render the component
      if (!renderContainerRef.current) {
        setOutput("Error: Render container not found");
        return;
      }

      // Load the bundled module via blob URL
      const blob = new Blob([buildResult.code], {
        type: "application/javascript",
      });
      const url = URL.createObjectURL(blob);

      try {
        const module = await import(/* @vite-ignore */ url);

        // Look for an exported React component (MyComponent, default, or Component)
        const Component =
          module.MyComponent || module.default || module.Component;

        if (!Component) {
          setOutput(
            "Error: No component export found. Export a component as 'MyComponent', 'Component', or 'default'.",
          );
          return;
        }

        // Create a new React root and render the component
        const root = ReactDOM.createRoot(renderContainerRef.current);
        reactRootRef.current = root;
        root.render(React.createElement(Component));

        // Show success info
        const logs: string[] = [];
        logs.push("[Tailwind CSS: enabled]");
        logs.push("[Shared Modules: react, react/jsx-runtime, react-dom/client]");
        logs.push("");
        logs.push("Component loaded and rendered with Tailwind CSS!");
        logs.push(
          `Bundle size: ${(buildResult.code.length / 1024).toFixed(2)} KB (includes generated CSS)`,
        );

        setOutput(logs.join("\n"));
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setOutput(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="example-card">
      <h2>Shared Modules (React)</h2>
      <p className="description">
        Compile a React component from TypeScript and render it using the same
        React instance as the host page. This avoids the "multiple React
        instances" problem.
      </p>
      <textarea
        className="code-editor"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        spellCheck={false}
      />
      <div className="button-row">
        <button onClick={runCode} disabled={isRunning}>
          {isRunning ? "Building..." : "Build & Render"}
        </button>
      </div>
      <div className="output-label">Rendered Component</div>
      <div
        ref={renderContainerRef}
        className="render-container"
        style={{
          minHeight: "120px",
          padding: "16px",
          background: "#1a1a2e",
          borderRadius: "8px",
          marginBottom: "12px",
        }}
      >
        <span style={{ color: "#666", fontStyle: "italic" }}>
          Click "Build &amp; Render" to see the component...
        </span>
      </div>
      <div className="output-label">Console Output</div>
      <div
        className={`output-panel ${output.includes("Error") ? "error" : ""}`}
      >
        {output || "Build logs will appear here..."}
      </div>
    </div>
  );
}
