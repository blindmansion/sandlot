import { useState } from "react";
import { createBuilder } from "sandlot";

export function BasicExample() {
  const [code, setCode] = useState(`// Try editing this TypeScript code!
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export function add(a: number, b: number): number {
  return a + b;
}
`);
  const [output, setOutput] = useState("");
  const [isRunning, setIsRunning] = useState(false);

  const runCode = async () => {
    setIsRunning(true);
    setOutput("");

    try {
      // Create a builder that writes code and builds it
      const runBuild = createBuilder({
        sandboxOptions: {},
        build: async (sandbox, prompt) => {
          // Write the code directly to the filesystem
          await sandbox.fs.writeFile("/src/index.ts", prompt);

          // Type check first
          const tscResult = await sandbox.bash.exec("tsc /src/index.ts");
          if (tscResult.exitCode !== 0) {
            throw new Error(
              `Type Error:\n${tscResult.stderr || tscResult.stdout}`
            );
          }

          // Build the code
          const buildResult = await sandbox.bash.exec("build /src/index.ts");
          if (buildResult.exitCode !== 0) {
            throw new Error(
              `Build Error:\n${buildResult.stderr || buildResult.stdout}`
            );
          }
        },
      });

      // Run with the code as the "prompt"
      const result = await runBuild(code);

      if (result.error) {
        setOutput(result.error.message);
        return;
      }

      if (!result.module) {
        setOutput("Build failed: no output");
        return;
      }

      // The module is already loaded
      const mod = result.module as {
        greet: (name: string) => string;
        add: (a: number, b: number) => number;
      };

      // Test the exports
      const logs: string[] = [];
      logs.push(`greet("World") = "${mod.greet("World")}"`);
      logs.push(`greet("Sandlot") = "${mod.greet("Sandlot")}"`);
      logs.push(`add(2, 3) = ${mod.add(2, 3)}`);
      logs.push(`add(10, 20) = ${mod.add(10, 20)}`);

      setOutput(logs.join("\n"));
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
