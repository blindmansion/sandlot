import { useState, useEffect, useRef } from "react";
import type { Sandbox, Sandlot, Diagnostic, BundleError } from "sandlot";
import { createBrowserSandlot } from "sandlot/browser";

// Format type check diagnostics for display
function formatDiagnostics(diagnostics: Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      const loc = d.file && d.line ? `${d.file}:${d.line}${d.column ? `:${d.column}` : ""}` : "";
      const prefix = d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info";
      return loc ? `${loc} - ${prefix}: ${d.message}` : `${prefix}: ${d.message}`;
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

export function BasicExample() {
  const [code, setCode] = useState(`// Try editing this TypeScript code!
export function main() {
  console.log("Hello from Sandlot!");
  console.log("2 + 3 =", 2 + 3);
  return { success: true };
}
`);
  const [output, setOutput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const sandlotRef = useRef<Sandlot | null>(null);
  const sandboxRef = useRef<Sandbox | null>(null);

  // Initialize sandlot once on mount
  useEffect(() => {
    createBrowserSandlot().then((sandlot) => {
      sandlotRef.current = sandlot;
    });
  }, []);

  const runCode = async () => {
    setIsRunning(true);
    setOutput("");

    try {
      // Ensure sandlot is initialized
      if (!sandlotRef.current) {
        sandlotRef.current = await createBrowserSandlot();
      }

      // Create a fresh sandbox for each run
      const sandbox = await sandlotRef.current.createSandbox();
      sandboxRef.current = sandbox;

      // Write the code to the sandbox
      sandbox.writeFile("/index.ts", code);

      // Build first to get detailed errors
      const buildResult = await sandbox.build();

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
            if (buildResult.bundleErrors && buildResult.bundleErrors.length > 0) {
              errorOutput += formatBundleErrors(buildResult.bundleErrors);
            } else {
              errorOutput += "Bundle failed (no details available)";
            }
            break;
        }

        setOutput(errorOutput);
        return;
      }

      // Build succeeded - now run the code
      const result = await sandbox.run({ skipTypecheck: true }); // Skip typecheck since we already did it

      if (!result.success) {
        setOutput(`Execution Error: ${result.error ?? "Unknown error"}`);
        return;
      }

      // Collect output
      const logs: string[] = [];
      
      // Show captured console output
      if (result.logs.length > 0) {
        logs.push(...result.logs);
      }

      // Show return value if present
      if (result.returnValue !== undefined) {
        logs.push(`\n[return] ${JSON.stringify(result.returnValue, null, 2)}`);
      }

      // Show execution time
      if (result.executionTimeMs !== undefined) {
        logs.push(`\nCompleted in ${result.executionTimeMs.toFixed(2)}ms`);
      }

      setOutput(logs.join("\n") || "Code executed successfully (no output)");
    } catch (err) {
      setOutput(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="example-card">
      <h2>Basic TypeScript Compilation</h2>
      <p className="description">
        Write TypeScript code, compile it with type checking, and run it in the
        browser.
      </p>
      <textarea
        className="code-editor"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        spellCheck={false}
      />
      <div className="button-row">
        <button onClick={runCode} disabled={isRunning}>
          {isRunning ? "Running..." : "Run Code"}
        </button>
      </div>
      <div className="output-label">Output</div>
      <div className={`output-panel ${output.includes("Error") ? "error" : ""}`}>
        {output || "Click 'Run Code' to see output..."}
      </div>
    </div>
  );
}
