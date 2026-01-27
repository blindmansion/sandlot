import { useState, useEffect } from "react";
import { createSandbox, type Sandbox } from "sandlot";

export function BashExample() {
  const [command, setCommand] = useState("ls /");
  const [history, setHistory] = useState<string[]>([]);
  const [sandbox, setSandbox] = useState<Sandbox | null>(null);

  useEffect(() => {
    createSandbox({
      initialFiles: {
        "hello.ts": `import { nanoid } from "nanoid";
console.log("Hello from hello.ts!");
console.log("Nanoid:", nanoid());`,
        "math.ts": "export const add = (a: number, b: number) => a + b;",
      },
    }).then((newSandbox) => {
      setSandbox(newSandbox);
    });
  }, []);

  const runCommand = async () => {
    if (!sandbox || !command.trim()) return;

    setHistory((prev) => [...prev, `$ ${command}`]);

    try {
      const result = await sandbox.bash.exec(command);
      const output = result.stdout || result.stderr || "(no output)";
      setHistory((prev) => [...prev, output]);
    } catch (err) {
      const errorMsg = `Error: ${err instanceof Error ? err.message : String(err)}`;
      setHistory((prev) => [...prev, errorMsg]);
    }

    setCommand("");
  };

  const quickCommands = [
    { label: "ls /", cmd: "ls /" },
    { label: "cat hello.ts", cmd: "cat hello.ts" },
    { label: "install nanoid", cmd: "install nanoid" },
    { label: "run hello.ts", cmd: "run hello.ts" },
    { label: "build math.ts", cmd: "build math.ts" },
    { label: "tsc hello.ts", cmd: "tsc hello.ts" },
  ];

  return (
    <div className="example-card">
      <h2>Bash Shell</h2>
      <p className="description">
        Interact with the virtual filesystem using familiar bash commands.
      </p>
      <div className="button-row">
        {quickCommands.map((qc) => (
          <button
            key={qc.cmd}
            className="secondary"
            onClick={() => {
              setCommand(qc.cmd);
            }}
            style={{ padding: "0.375rem 0.75rem", fontSize: "0.8125rem" }}
          >
            {qc.label}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runCommand()}
          placeholder="Enter a command..."
          style={{
            flex: 1,
            background: "#0d0d0d",
            border: "1px solid #333",
            borderRadius: "6px",
            padding: "0.625rem 1rem",
            color: "#e0e0e0",
            fontFamily: '"SF Mono", "Fira Code", monospace',
            fontSize: "0.875rem",
          }}
        />
        <button onClick={runCommand} disabled={!sandbox}>
          Run
        </button>
      </div>
      <div className="output-label">Terminal</div>
      <div
        className="output-panel"
        style={{ minHeight: "200px", maxHeight: "400px" }}
      >
        {history.length > 0
          ? history.join("\n")
          : "Try running some commands..."}
      </div>
    </div>
  );
}
