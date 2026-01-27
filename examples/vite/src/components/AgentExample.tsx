import { useState, useMemo } from "react";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { createBuilder, registerSharedModules } from "sandlot";
import { runMockAgent } from "../mock-agent";
import {
  runMockAgentErrorAfterBuild,
  runMockAgentErrorBeforeBuild,
  runMockAgentTypeError,
} from "../mock-agent-error";
import {
  runMockAgentForgotToBuild,
  runMockAgentOnlyWrites,
  runMockAgentIgnoresBuildFailure,
  runMockAgentDeclinesToBuild,
} from "../mock-agent-no-build";

// Register React so dynamically loaded components share the same instance
registerSharedModules({
  react: React,
  "react/jsx-runtime": jsxRuntime,
});

type AgentScenario =
  | "counter"
  | "clock"
  | "todo"
  | "greeting"
  | "error-after-build"
  | "error-before-build"
  | "type-error"
  | "forgot-to-build"
  | "only-writes"
  | "ignores-build-failure"
  | "declines-to-build"
  | "validation-passes"
  | "validation-fails"
  | "validation-with-counter";

const SCENARIOS: { value: AgentScenario; label: string; group: string }[] = [
  { value: "counter", label: "Counter", group: "Success" },
  { value: "clock", label: "Clock", group: "Success" },
  { value: "todo", label: "Todo List", group: "Success" },
  { value: "greeting", label: "Greeting", group: "Success" },
  { value: "error-after-build", label: "Error After Build", group: "Errors" },
  { value: "error-before-build", label: "Error Before Build", group: "Errors" },
  { value: "type-error", label: "Type Check Error", group: "Errors" },
  { value: "forgot-to-build", label: "Forgot to Build", group: "No Build" },
  { value: "only-writes", label: "Only Writes Files", group: "No Build" },
  { value: "ignores-build-failure", label: "Ignores Build Failure", group: "No Build" },
  { value: "declines-to-build", label: "Declines to Build", group: "No Build" },
  { value: "validation-passes", label: "Validation Passes", group: "Validation" },
  { value: "validation-fails", label: "Validation Fails", group: "Validation" },
  { value: "validation-with-counter", label: "Validation w/ Counter Type", group: "Validation" },
];

export function AgentExample() {
  const [scenario, setScenario] = useState<AgentScenario>("counter");
  const [isRunning, setIsRunning] = useState(false);
  const [moduleError, setModuleError] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [Component, setComponent] = useState<React.ComponentType | null>(null);
  const [bundleSize, setBundleSize] = useState<number | null>(null);
  const [agentResult, setAgentResult] = useState<unknown>(null);
  const [hadBundle, setHadBundle] = useState<boolean | null>(null);
  const [validationInfo, setValidationInfo] = useState<string | null>(null);

  // Create the builder once - it handles sandbox creation internally
  const builder = useMemo(() => createBuilder({
    sandboxOptions: {
      sharedModules: ["react", "react/jsx-runtime"],
    },
    build: async (sandbox, prompt): Promise<unknown> => {
      // Use the prompt as the scenario selector
      switch (prompt as AgentScenario) {
        case "counter":
          return runMockAgent(sandbox, "Build me a counter component");
        case "clock":
          return runMockAgent(sandbox, "Build me a clock");
        case "todo":
          return runMockAgent(sandbox, "Build me a todo list");
        case "greeting":
          return runMockAgent(sandbox, "Build me a greeting");
        case "error-after-build":
          return runMockAgentErrorAfterBuild(sandbox);
        case "error-before-build":
          return runMockAgentErrorBeforeBuild(sandbox);
        case "type-error":
          return runMockAgentTypeError(sandbox);
        case "forgot-to-build":
          return runMockAgentForgotToBuild(sandbox);
        case "only-writes":
          return runMockAgentOnlyWrites(sandbox);
        case "ignores-build-failure":
          return runMockAgentIgnoresBuildFailure(sandbox);
        case "declines-to-build":
          return runMockAgentDeclinesToBuild(sandbox);
        case "validation-passes":
          return runMockAgent(sandbox, "Build me a counter component");
        case "validation-fails":
          // Build a greeting (no initialCount export) but we'll validate for initialCount
          return runMockAgent(sandbox, "Build me a greeting");
        case "validation-with-counter":
          return runMockAgent(sandbox, "Build me a counter component");
        default:
          throw new Error(`Unknown scenario: ${prompt}`);
      }
    },
  }), []);

  const runAgent = async () => {
    setIsRunning(true);
    setModuleError(null);
    setComponent(null);
    setBundleSize(null);
    setAgentResult(null);
    setHadBundle(null);
    setAgentError(null);
    setValidationInfo(null);

    // Call the builder with the scenario as the prompt
    // For validation scenarios, pass validation options
    type ValidatedModule = { App: React.ComponentType; initialCount?: number };

    const run = await (async () => {
      switch (scenario) {
        case "validation-passes":
          // Simple validation - just check App exists and is a function
          return builder(scenario, {
            validate: (mod): ValidatedModule => {
              if (typeof mod.App !== "function") {
                throw new Error("Module must export an App component");
              }
              return { App: mod.App as React.ComponentType };
            },
          });

        case "validation-fails":
          // This will fail - greeting doesn't export initialCount
          return builder(scenario, {
            validate: (mod): ValidatedModule => {
              if (typeof mod.App !== "function") {
                throw new Error("Module must export an App component");
              }
              if (typeof mod.initialCount !== "number") {
                throw new Error("Module must export initialCount as a number");
              }
              return {
                App: mod.App as React.ComponentType,
                initialCount: mod.initialCount,
              };
            },
          });

        case "validation-with-counter":
          // Validate and type the counter component
          return builder(scenario, {
            validate: (mod): ValidatedModule => {
              if (typeof mod.App !== "function") {
                throw new Error("Module must export an App component");
              }
              return {
                App: mod.App as React.ComponentType,
                initialCount: typeof mod.initialCount === "number" ? mod.initialCount : 0,
              };
            },
          });

        default:
          // No validation for other scenarios
          return builder(scenario);
      }
    })();

    setIsRunning(false);
    setHadBundle(run.bundle !== null);
    setAgentResult(run.result);
    setAgentError(run.error?.message ?? null);

    if (run.bundle) {
      setBundleSize(run.bundle.code.length);
    }

    // Set validation info for validation scenarios
    const isValidationScenario = scenario.startsWith("validation-");
    if (isValidationScenario && run.module) {
      const moduleKeys = Object.keys(run.module);
      setValidationInfo(`Validated module exports: ${moduleKeys.join(", ")}`);
    } else if (isValidationScenario && run.error) {
      setValidationInfo("Validation failed (see error above)");
    }

    // Module is auto-loaded - just check if it has the App export
    if (run.module?.App) {
      const App = run.module.App as React.ComponentType;
      setComponent(() => App);
    } else if (!run.error && !run.bundle) {
      // No bundle and no errors - this is a "no build" scenario
      setModuleError("Agent completed but no bundle was produced");
    } else if (run.module && !run.module.App) {
      // Module loaded but no App export
      setModuleError(`No 'App' export found. Available: ${Object.keys(run.module).join(", ")}`);
    }
  };

  // Group scenarios for display
  const groups = ["Success", "Errors", "No Build", "Validation"];

  return (
    <div className="example-card">
      <h2>Agent Workflow Demo</h2>
      <p className="description">
        Demonstrates <code>createBuilder()</code> with mock agents including
        error and no-build scenarios.
      </p>

      <div className="prompt-row">
        <select
          value={scenario}
          onChange={(e) => setScenario(e.target.value as AgentScenario)}
          disabled={isRunning}
        >
          {groups.map((group) => (
            <optgroup key={group} label={group}>
              {SCENARIOS.filter((s) => s.group === group).map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button onClick={runAgent} disabled={isRunning}>
          {isRunning ? "Running..." : "Run Agent"}
        </button>
      </div>

      {agentError && (
        <div className="output-panel warning">
          <strong>Agent error:</strong> {agentError}
          {hadBundle && (
            <div style={{ marginTop: "8px", color: "#2e7d32" }}>
              Bundle was captured before the error!
            </div>
          )}
        </div>
      )}

      {moduleError && (
        <div className="output-panel error">{moduleError}</div>
      )}

      {agentResult !== undefined && agentResult !== null && (
        <div className="output-panel">
          <strong>Agent returned:</strong>{" "}
          <code>{JSON.stringify(agentResult)}</code>
        </div>
      )}

      {validationInfo && (
        <div className="output-panel success">
          <strong>Validation:</strong> {validationInfo}
        </div>
      )}

      {hadBundle !== null && !Component && !moduleError && !agentError && (
        <div className="output-panel">
          Bundle captured: {hadBundle ? "Yes" : "No"}
        </div>
      )}

      {Component && (
        <div className="preview-section">
          <div className="preview-header">
            <span>Live Preview</span>
            {bundleSize && (
              <span className="bundle-size">
                {(bundleSize / 1024).toFixed(2)} KB
              </span>
            )}
          </div>
          <div className="preview-content">
            <Component />
          </div>
        </div>
      )}

      <style>{`
        .prompt-row {
          display: flex;
          gap: 12px;
          margin-bottom: 16px;
        }
        
        .prompt-row select {
          flex: 1;
          padding: 8px 12px;
          border: 1px solid #444;
          border-radius: 6px;
          font-size: 14px;
          background: #1a1a1a;
          color: #e0e0e0;
        }
        
        .preview-section {
          margin-top: 16px;
          border: 1px solid #c8e6c9;
          border-radius: 8px;
          overflow: hidden;
        }
        
        .preview-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 12px;
          background: #e8f5e9;
          color: #2e7d32;
          font-weight: 500;
          font-size: 13px;
        }
        
        .bundle-size {
          font-weight: normal;
          color: #555;
        }
        
        .preview-content {
          padding: 16px;
          background: white;
          color: #333;
        }
        
        .preview-content button {
          padding: 8px 16px;
          cursor: pointer;
        }
        
        .preview-content input {
          border: 1px solid #ddd;
          border-radius: 4px;
        }
      `}</style>
    </div>
  );
}
