/**
 * Run command for executing code in the sandbox.
 */

import { defineCommand, type CommandContext } from "just-bash/browser";
import { typecheck, formatDiagnosticsForAgent } from "../typechecker";
import { bundle } from "../bundler";
import { loadModule } from "../loader";
import type { CommandDeps, RunContext } from "./types";

/**
 * Create the `run` command for executing code in the sandbox.
 *
 * The run command:
 * 1. Builds the entry point (with type checking by default)
 * 2. Dynamically imports the bundle
 * 3. If a `main` export exists, calls it with a RunContext
 * 4. Captures all console output (log, warn, error)
 * 5. Returns the captured output and any return value from main()
 *
 * Usage:
 *   run [entry] [--skip-typecheck|-s] [--timeout|-t <ms>] [-- args...]
 *
 * Code can be written in two styles:
 *
 * 1. Script style (top-level code, runs on import):
 *    ```ts
 *    console.log("Hello from script!");
 *    const result = 2 + 2;
 *    console.log("Result:", result);
 *    ```
 *
 * 2. Main function style (with context access):
 *    ```ts
 *    import type { RunContext } from "sandlot";
 *
 *    export async function main(ctx: RunContext) {
 *      ctx.log("Reading file...");
 *      const content = await ctx.fs.readFile("/data/input.txt");
 *      ctx.log("Content:", content);
 *      return { success: true };
 *    }
 *    ```
 */
export function createRunCommand(deps: CommandDeps) {
  const { fs, libFiles, tsconfigPath, runOptions = {}, sharedModules } = deps;

  return defineCommand("run", async (args, _ctx: CommandContext) => {
    // Parse arguments
    let entryPoint: string | null = null;
    let skipTypecheck = runOptions.skipTypecheck ?? false;
    let timeout = runOptions.timeout ?? 30000;
    const scriptArgs: string[] = [];
    let collectingArgs = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (collectingArgs) {
        scriptArgs.push(arg!);
        continue;
      }

      if (arg === "--") {
        collectingArgs = true;
      } else if (arg === "--skip-typecheck" || arg === "-s") {
        skipTypecheck = true;
      } else if ((arg === "--timeout" || arg === "-t") && args[i + 1]) {
        timeout = parseInt(args[++i]!, 10);
        if (isNaN(timeout)) timeout = 30000;
      } else if (!arg!.startsWith("-")) {
        entryPoint = arg!;
      }
    }

    // Entry point is required
    if (!entryPoint) {
      return {
        stdout: "",
        stderr: `Usage: run <entry-point> [options] [-- args...]\n\nOptions:\n  --skip-typecheck, -s  Skip type checking\n  --timeout, -t <ms>    Execution timeout (default: 30000)\n\nExample: run /src/index.ts\n`,
        exitCode: 1,
      };
    }

    // Capture console output
    const logs: string[] = [];
    const originalConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
      debug: console.debug,
    };

    const formatArgs = (...a: unknown[]) =>
      a.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(" ");

    const captureLog = (...a: unknown[]) => {
      logs.push(formatArgs(...a));
      originalConsole.log.apply(console, a);
    };
    const captureWarn = (...a: unknown[]) => {
      logs.push(`[warn] ${formatArgs(...a)}`);
      originalConsole.warn.apply(console, a);
    };
    const captureError = (...a: unknown[]) => {
      logs.push(`[error] ${formatArgs(...a)}`);
      originalConsole.error.apply(console, a);
    };
    const captureInfo = (...a: unknown[]) => {
      logs.push(`[info] ${formatArgs(...a)}`);
      originalConsole.info.apply(console, a);
    };
    const captureDebug = (...a: unknown[]) => {
      logs.push(`[debug] ${formatArgs(...a)}`);
      originalConsole.debug.apply(console, a);
    };

    const restoreConsole = () => {
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      console.info = originalConsole.info;
      console.debug = originalConsole.debug;
    };

    try {
      // Check if entry point exists
      if (!(await fs.exists(entryPoint))) {
        return {
          stdout: "",
          stderr: `Error: Entry point not found: ${entryPoint}\n`,
          exitCode: 1,
        };
      }

      // Type check (unless skipped)
      if (!skipTypecheck) {
        const typecheckResult = await typecheck({
          fs,
          entryPoint,
          tsconfigPath,
          libFiles,
        });

        if (typecheckResult.hasErrors) {
          const formatted = formatDiagnosticsForAgent(typecheckResult.diagnostics);
          return {
            stdout: "",
            stderr: `Type errors:\n${formatted}\n`,
            exitCode: 1,
          };
        }
      }

      // Bundle the code
      const bundleResult = await bundle({
        fs,
        entryPoint,
        format: "esm",
        sharedModules,
      });

      // Install console interceptors
      console.log = captureLog;
      console.warn = captureWarn;
      console.error = captureError;
      console.info = captureInfo;
      console.debug = captureDebug;

      // Create the run context
      const context: RunContext = {
        fs,
        env: { ...runOptions.env },
        args: scriptArgs,
        log: captureLog,
        error: captureError,
      };

      // Execute the code with optional timeout
      const startTime = performance.now();
      let returnValue: unknown;

      const executeCode = async () => {
        // Load the module (this executes top-level code)
        const module = await loadModule<{ main?: (ctx: RunContext) => unknown }>(bundleResult);

        // If there's a main export, call it with context
        if (typeof module.main === "function") {
          returnValue = await module.main(context);
        }
      };

      if (timeout > 0) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Execution timed out after ${timeout}ms`)), timeout);
        });
        await Promise.race([executeCode(), timeoutPromise]);
      } else {
        await executeCode();
      }

      const executionTimeMs = performance.now() - startTime;

      // Restore console before building output
      restoreConsole();

      // Build output
      let output = "";
      if (logs.length > 0) {
        output = logs.join("\n") + "\n";
      }
      if (returnValue !== undefined) {
        const returnStr =
          typeof returnValue === "object"
            ? JSON.stringify(returnValue, null, 2)
            : String(returnValue);
        output += `[return] ${returnStr}\n`;
      }
      output += `\nExecution completed in ${executionTimeMs.toFixed(2)}ms\n`;

      return {
        stdout: output,
        stderr: "",
        exitCode: 0,
      };
    } catch (err) {
      restoreConsole();

      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorStack = err instanceof Error && err.stack ? `\n${err.stack}` : "";

      let output = "";
      if (logs.length > 0) {
        output = logs.join("\n") + "\n\n";
      }

      return {
        stdout: output,
        stderr: `Runtime error: ${errorMessage}${errorStack}\n`,
        exitCode: 1,
      };
    }
  });
}
