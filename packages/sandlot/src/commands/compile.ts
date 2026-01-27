/**
 * Compile-related commands: tsc and build
 */

import { defineCommand, type CommandContext } from "just-bash/browser";
import { typecheck, formatDiagnosticsForAgent, type TypecheckResult } from "../typechecker";
import { bundle } from "../bundler";
import { loadModule } from "../loader";
import { type CommandDeps, formatEsbuildMessages } from "./types";

/**
 * Create the `tsc` command for type checking
 */
export function createTscCommand(deps: CommandDeps) {
  const { fs, libFiles, tsconfigPath } = deps;

  return defineCommand("tsc", async (args, _ctx: CommandContext) => {
    const entryPoint = args[0];
    if (!entryPoint) {
      return {
        stdout: "",
        stderr: `Usage: tsc <entry-point>\n\nExample: tsc /src/index.ts\n`,
        exitCode: 1,
      };
    }

    try {
      // Check if entry point exists
      if (!(await fs.exists(entryPoint))) {
        return {
          stdout: "",
          stderr: `Error: Entry point not found: ${entryPoint}\n`,
          exitCode: 1,
        };
      }

      const result = await typecheck({
        fs,
        entryPoint,
        tsconfigPath,
        libFiles,
      });

      if (result.hasErrors) {
        const formatted = formatDiagnosticsForAgent(result.diagnostics);
        return {
          stdout: "",
          stderr: formatted + "\n",
          exitCode: 1,
        };
      }

      const checkedCount = result.checkedFiles.length;
      const warningCount = result.diagnostics.filter((d) => d.category === "warning").length;

      let output = `Type check passed. Checked ${checkedCount} file(s).\n`;
      if (warningCount > 0) {
        output += `\nWarnings:\n${formatDiagnosticsForAgent(result.diagnostics.filter((d) => d.category === "warning"))}\n`;
      }

      return {
        stdout: output,
        stderr: "",
        exitCode: 0,
      };
    } catch (err) {
      return {
        stdout: "",
        stderr: `Type check failed: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
  });
}

/**
 * Create the `build` command for bundling (with automatic type checking)
 */
export function createBuildCommand(deps: CommandDeps) {
  const { fs, libFiles, tsconfigPath, onBuild, getValidation, sharedModules } = deps;

  return defineCommand("build", async (args, _ctx: CommandContext) => {
    // Parse arguments
    let entryPoint: string | null = null;
    let skipTypecheck = false;
    let minify = false;
    let format: "esm" | "iife" | "cjs" = "esm";

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--skip-typecheck" || arg === "-s") {
        skipTypecheck = true;
      } else if (arg === "--minify" || arg === "-m") {
        minify = true;
      } else if ((arg === "--format" || arg === "-f") && args[i + 1]) {
        const f = args[++i]!.toLowerCase();
        if (f === "esm" || f === "iife" || f === "cjs") {
          format = f;
        }
      } else if (!arg!.startsWith("-")) {
        entryPoint = arg!;
      }
    }

    // Entry point is required
    if (!entryPoint) {
      return {
        stdout: "",
        stderr: `Usage: build <entry-point> [options]\n\nOptions:\n  --skip-typecheck, -s  Skip type checking\n  --minify, -m          Minify output\n  --format, -f <fmt>    Output format (esm|iife|cjs)\n\nExample: build /src/index.ts\n`,
        exitCode: 1,
      };
    }

    try {
      // Check if entry point exists
      if (!(await fs.exists(entryPoint))) {
        return {
          stdout: "",
          stderr: `Error: Entry point not found: ${entryPoint}\n`,
          exitCode: 1,
        };
      }

      // Step 1: Type check (unless skipped)
      let typecheckResult: TypecheckResult | null = null;
      if (!skipTypecheck) {
        typecheckResult = await typecheck({
          fs,
          entryPoint,
          tsconfigPath,
          libFiles,
        });

        if (typecheckResult.hasErrors) {
          const formatted = formatDiagnosticsForAgent(typecheckResult.diagnostics);
          return {
            stdout: "",
            stderr: `Build failed: Type errors found.\n\n${formatted}\n`,
            exitCode: 1,
          };
        }
      }

      // Step 2: Bundle
      const bundleResult = await bundle({
        fs,
        entryPoint,
        format,
        minify,
        sharedModules,
      });

      // Step 3: Load module
      let loadedModule: Record<string, unknown>;
      try {
        loadedModule = await loadModule<Record<string, unknown>>(bundleResult);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          stdout: "",
          stderr: `Build failed: Module failed to load.\n\n${errorMessage}\n`,
          exitCode: 1,
        };
      }

      // Step 4: Validate (if validation function is set)
      const validateFn = getValidation?.();
      let validatedModule = loadedModule;

      if (validateFn) {
        try {
          validatedModule = validateFn(loadedModule);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          return {
            stdout: "",
            stderr: `Build failed: Validation error.\n\n${errorMessage}\n`,
            exitCode: 1,
          };
        }
      }

      // Invoke callback with build output (bundle + validated module)
      if (onBuild) {
        await onBuild({ bundle: bundleResult, module: validatedModule });
      }

      // Build success message
      let output = `Build successful!\n`;
      output += `Entry: ${entryPoint}\n`;
      output += `Format: ${format}\n`;
      output += `Size: ${(bundleResult.code.length / 1024).toFixed(2)} KB\n`;

      if (typecheckResult) {
        output += `Type checked: ${typecheckResult.checkedFiles.length} file(s)\n`;
      }

      output += `Bundled: ${bundleResult.includedFiles.length} file(s)\n`;

      // Show exports for visibility
      const exportNames = Object.keys(loadedModule).filter((k) => !k.startsWith("__"));
      if (exportNames.length > 0) {
        output += `Exports: ${exportNames.join(", ")}\n`;
      }

      if (validateFn) {
        output += `Validation: passed\n`;
      }

      // Include warnings if any
      if (bundleResult.warnings.length > 0) {
        output += `\nBuild warnings:\n${formatEsbuildMessages(bundleResult.warnings)}\n`;
      }

      if (typecheckResult) {
        const warnings = typecheckResult.diagnostics.filter((d) => d.category === "warning");
        if (warnings.length > 0) {
          output += `\nType warnings:\n${formatDiagnosticsForAgent(warnings)}\n`;
        }
      }

      return {
        stdout: output,
        stderr: "",
        exitCode: 0,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: `Build failed: ${errorMessage}\n`,
        exitCode: 1,
      };
    }
  });
}
