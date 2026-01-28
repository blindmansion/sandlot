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
    useState(`// This React component uses the SAME React instance as the host page!
// Just export a component - the host will render it.

import { useState } from 'react';

export function MyComponent() {
  const [count, setCount] = useState(0);
  
  return (
    <div style={{ 
      padding: '20px', 
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      borderRadius: '12px',
      color: 'white',
      fontFamily: 'system-ui, sans-serif',
      textAlign: 'center'
    }}>
      <h3 style={{ margin: '0 0 16px 0' }}>Dynamic React Component</h3>
      <p style={{ margin: '0 0 12px 0' }}>
        This component was compiled and rendered using shared React!
      </p>
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        gap: '12px'
      }}>
        <button
          onClick={() => setCount((c) => c - 1)}
          style={{
            padding: '8px 16px',
            fontSize: '18px',
            border: 'none',
            borderRadius: '6px',
            background: 'rgba(255,255,255,0.2)',
            color: 'white',
            cursor: 'pointer'
          }}
        >
          -
        </button>
        <span style={{ fontSize: '24px', fontWeight: 'bold', minWidth: '60px' }}>
          {count}
        </span>
        <button
          onClick={() => setCount((c) => c + 1)}
          style={{
            padding: '8px 16px',
            fontSize: '18px',
            border: 'none',
            borderRadius: '6px',
            background: 'rgba(255,255,255,0.2)',
            color: 'white',
            cursor: 'pointer'
          }}
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

    // Clear previous render
    if (renderContainerRef.current) {
      renderContainerRef.current.innerHTML = "";
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

      // Build first to get detailed errors
      const buildResult = await sandbox.build({
        entryPoint: "/index.tsx",
        skipTypecheck: true,
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

        // Unmount previous root if exists
        if (reactRootRef.current) {
          reactRootRef.current.unmount();
        }

        // Create a new React root and render the component
        const root = ReactDOM.createRoot(renderContainerRef.current);
        reactRootRef.current = root;
        root.render(React.createElement(Component));

        // Show success info
        const logs: string[] = [];
        logs.push(
          "[Shared Modules: react, react/jsx-runtime, react-dom/client]",
        );
        logs.push("");
        logs.push("Component loaded and rendered successfully!");
        logs.push(
          `Bundle size: ${(buildResult.code.length / 1024).toFixed(2)} KB`,
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
