import { useState, useEffect, useRef } from "react";
import type { Sandbox, Sandlot, Diagnostic, BundleError } from "sandlot";
import { createBrowserSandlot, createIframeExecutor } from "sandlot/browser";

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

export function IframeExample() {
  const [code, setCode] = useState(`// This code runs in a sandboxed iframe!
// It has NO access to the parent page's DOM or JavaScript.

export function main() {
  console.log("Hello from sandboxed iframe!");
  
  // Iframe's own location is "about:srcdoc" (from srcdoc attribute)
  console.log("Iframe location:", window.location.href);
  
  // Try to access PARENT's document - this fails in strict sandbox
  try {
    const parentDoc = parent.document;
    console.log("Parent access: ALLOWED (relaxed mode)");
  } catch (e) {
    console.log("Parent access: BLOCKED (strict mode)");
  }
  
  // Try localStorage - fails without allow-same-origin
  try {
    localStorage.setItem("test", "value");
    console.log("localStorage: ALLOWED");
  } catch (e) {
    console.log("localStorage: BLOCKED (no same-origin)");
  }
  
  // Regular JavaScript works fine
  const numbers = [1, 2, 3, 4, 5];
  const sum = numbers.reduce((a, b) => a + b, 0);
  console.log("Sum of 1-5:", sum);
  
  return { executed: true, sum };
}
`);
  const [output, setOutput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [sandboxMode, setSandboxMode] = useState<"strict" | "relaxed">("strict");
  const sandlotRef = useRef<Sandlot | null>(null);
  const sandboxRef = useRef<Sandbox | null>(null);
  const currentModeRef = useRef<string>(sandboxMode);

  // Reinitialize sandlot when sandbox mode changes
  useEffect(() => {
    currentModeRef.current = sandboxMode;
    sandlotRef.current = null; // Force reinit on next run
  }, [sandboxMode]);

  const runCode = async () => {
    setIsRunning(true);
    setOutput("");

    try {
      // Create sandlot with iframe executor if needed
      if (!sandlotRef.current) {
        const sandboxAttrs = sandboxMode === "strict" 
          ? ["allow-scripts"] 
          : ["allow-scripts", "allow-same-origin"];
        
        sandlotRef.current = await createBrowserSandlot({
          executor: createIframeExecutor({ sandbox: sandboxAttrs }),
        });
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
      
      // Show sandbox mode info
      logs.push(`[Sandbox Mode: ${sandboxMode}]`);
      logs.push(`[Sandbox Attrs: ${sandboxMode === "strict" ? "allow-scripts" : "allow-scripts, allow-same-origin"}]`);
      logs.push("");
      
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
      <h2>Iframe Sandbox Execution</h2>
      <p className="description">
        Run TypeScript code in a sandboxed iframe for better isolation. 
        The code runs in a separate browsing context with no access to the parent page.
      </p>
      <div className="button-row" style={{ marginBottom: "10px" }}>
        <label style={{ marginRight: "10px" }}>
          <input
            type="radio"
            name="sandboxMode"
            value="strict"
            checked={sandboxMode === "strict"}
            onChange={() => setSandboxMode("strict")}
          />
          {" "}Strict (allow-scripts only)
        </label>
        <label>
          <input
            type="radio"
            name="sandboxMode"
            value="relaxed"
            checked={sandboxMode === "relaxed"}
            onChange={() => setSandboxMode("relaxed")}
          />
          {" "}Relaxed (+allow-same-origin)
        </label>
      </div>
      <textarea
        className="code-editor"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        spellCheck={false}
      />
      <div className="button-row">
        <button onClick={runCode} disabled={isRunning}>
          {isRunning ? "Running..." : "Run in Iframe"}
        </button>
      </div>
      <div className="output-label">Output</div>
      <div className={`output-panel ${output.includes("Error") ? "error" : ""}`}>
        {output || "Click 'Run in Iframe' to see output..."}
      </div>
    </div>
  );
}
