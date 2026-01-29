/**
 * Command factories for v2 sandbox bash environments.
 *
 * Provides a `sandlot` command with subcommands:
 *   - sandlot build     Build the project
 *   - sandlot typecheck Type check without building
 *   - sandlot install   Install packages
 *   - sandlot uninstall Remove packages
 *   - sandlot help      Show help
 */

import { defineCommand, type CommandContext } from "just-bash/browser";
import type { SandboxRef } from "./types";
export type { SandboxRef } from "./types";
export {
  formatSize,
  formatDiagnostics,
  formatBundleErrors,
  formatBuildFailure,
} from "./types";

/**
 * Create the main `sandlot` command with all subcommands.
 *
 * The sandlot command is a dispatcher that routes to subcommand handlers.
 */
export function createSandlotCommand(sandboxRef: SandboxRef) {
  return defineCommand("sandlot", async (args, ctx: CommandContext) => {
    const subcommand = args[0];

    // No subcommand or help
    if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
      return showHelp();
    }

    // Dispatch to subcommand handlers
    switch (subcommand) {
      case "build":
        return handleBuild(sandboxRef, args.slice(1));

      case "typecheck":
      case "tsc":
        return handleTypecheck(sandboxRef, args.slice(1));

      case "install":
      case "add":
      case "i":
        return handleInstall(sandboxRef, args.slice(1));

      case "uninstall":
      case "remove":
      case "rm":
        return handleUninstall(sandboxRef, args.slice(1));

      case "run":
        return handleRun(sandboxRef, args.slice(1));

      default:
        return {
          stdout: "",
          stderr: `Unknown command: sandlot ${subcommand}\n\nRun 'sandlot help' for available commands.\n`,
          exitCode: 1,
        };
    }
  });
}

// =============================================================================
// Help
// =============================================================================

function showHelp() {
  return {
    stdout: `sandlot - In-browser TypeScript sandbox

Usage: sandlot <command> [options]

Commands:
  build       Build the project (typecheck, bundle)
  run         Build and execute code
  typecheck   Type check without building (alias: tsc)
  install     Install packages (aliases: add, i)
  uninstall   Remove packages (aliases: remove, rm)
  help        Show this help message

Run 'sandlot <command> --help' for command-specific options.

Examples:
  sandlot build
  sandlot run
  sandlot run --skip-typecheck --timeout 5000
  sandlot install react react-dom
  sandlot typecheck
`,
    stderr: "",
    exitCode: 0,
  };
}

// =============================================================================
// Build
// =============================================================================

import {
  formatSize,
  formatDiagnostics,
  formatBundleErrors,
  formatBuildFailure,
} from "./types";

async function handleBuild(sandboxRef: SandboxRef, args: (string | undefined)[]) {
  let entryPoint: string | undefined;
  let skipTypecheck = false;
  let minify = false;
  let tailwind = false;
  let format: "esm" | "iife" | "cjs" = "esm";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--skip-typecheck" || arg === "-s") {
      skipTypecheck = true;
    } else if (arg === "--minify" || arg === "-m") {
      minify = true;
    } else if (arg === "--tailwind" || arg === "-t") {
      tailwind = true;
    } else if ((arg === "--format" || arg === "-f") && args[i + 1]) {
      const f = args[++i]!.toLowerCase();
      if (f === "esm" || f === "iife" || f === "cjs") {
        format = f;
      }
    } else if ((arg === "--entry" || arg === "-e") && args[i + 1]) {
      entryPoint = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      return {
        stdout: `Usage: sandlot build [options]

Options:
  --entry, -e <path>     Entry point (default: from package.json main)
  --skip-typecheck, -s   Skip type checking
  --minify, -m           Minify output
  --tailwind, -t         Enable Tailwind CSS processing
  --format, -f <fmt>     Output format (esm|iife|cjs)
  --help, -h             Show this help message

Examples:
  sandlot build
  sandlot build --entry /src/main.ts
  sandlot build --skip-typecheck --minify
  sandlot build --tailwind
`,
        stderr: "",
        exitCode: 0,
      };
    } else if (arg && !arg.startsWith("-") && !entryPoint) {
      entryPoint = arg;
    }
  }

  const result = await sandboxRef.build({
    entryPoint,
    skipTypecheck,
    minify,
    format,
    tailwind,
  });

  // Handle build failure
  if (!result.success) {
    return {
      stdout: "",
      stderr: formatBuildFailure(result),
      exitCode: 1,
    };
  }

  // Build succeeded
  let output = `Build successful!\n`;
  output += `Size: ${formatSize(result.code.length)}\n`;
  output += `Files: ${result.includedFiles.length}\n`;

  if (result.warnings.length > 0) {
    output += `\nWarnings:\n`;
    for (const warning of result.warnings) {
      if (warning.location) {
        output += `  ${warning.location.file}:${warning.location.line}: ${warning.text}\n`;
      } else {
        output += `  ${warning.text}\n`;
      }
    }
  }

  return {
    stdout: output,
    stderr: "",
    exitCode: 0,
  };
}

// =============================================================================
// Typecheck
// =============================================================================

async function handleTypecheck(sandboxRef: SandboxRef, args: (string | undefined)[]) {
  let entryPoint: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--entry" || arg === "-e") && args[i + 1]) {
      entryPoint = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      return {
        stdout: `Usage: sandlot typecheck [options]

Options:
  --entry, -e <path>   Entry point (default: from package.json main)
  --help, -h           Show this help message

Aliases: sandlot tsc

Examples:
  sandlot typecheck
  sandlot typecheck --entry /src/main.ts
`,
        stderr: "",
        exitCode: 0,
      };
    } else if (arg && !arg.startsWith("-") && !entryPoint) {
      entryPoint = arg;
    }
  }

  try {
    const result = await sandboxRef.typecheck({ entryPoint });

    if (!result.success) {
      const errors = result.diagnostics.filter((d) => d.severity === "error");
      const formatted = formatDiagnostics(errors);
      return {
        stdout: "",
        stderr: `Type check failed\n\n${formatted}\n`,
        exitCode: 1,
      };
    }

    const warnings = result.diagnostics.filter((d) => d.severity === "warning");
    let output = `Type check passed\n`;

    if (warnings.length > 0) {
      output += `\nWarnings:\n\n${formatDiagnostics(warnings)}\n`;
    }

    return {
      stdout: output,
      stderr: "",
      exitCode: 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: "",
      stderr: `Type check error: ${message}\n`,
      exitCode: 1,
    };
  }
}

// =============================================================================
// Install
// =============================================================================

async function handleInstall(sandboxRef: SandboxRef, args: (string | undefined)[]) {
  // Check for help
  if (args.includes("--help") || args.includes("-h")) {
    return {
      stdout: `Usage: sandlot install <package>[@version] [...packages]

Examples:
  sandlot install react
  sandlot install lodash@4.17.21
  sandlot install @tanstack/react-query@5
  sandlot install react react-dom

Aliases: sandlot add, sandlot i
`,
      stderr: "",
      exitCode: 0,
    };
  }

  const packages = args.filter((a): a is string => !!a && !a.startsWith("-"));

  if (packages.length === 0) {
    return {
      stdout: "",
      stderr: `Usage: sandlot install <package>[@version] [...packages]\n\nRun 'sandlot install --help' for more information.\n`,
      exitCode: 1,
    };
  }

  const results: string[] = [];
  let hasError = false;

  for (const packageSpec of packages) {
    try {
      const result = await sandboxRef.install(packageSpec);

      let status = `+ ${result.name}@${result.version}`;
      if (result.previousVersion && result.previousVersion !== result.version) {
        status += ` (was ${result.previousVersion})`;
      }
      results.push(status);
    } catch (err) {
      hasError = true;
      const message = err instanceof Error ? err.message : String(err);
      results.push(`x ${packageSpec}: ${message}`);
    }
  }

  const output = results.join("\n") + "\n";

  return hasError
    ? { stdout: "", stderr: output, exitCode: 1 }
    : { stdout: output, stderr: "", exitCode: 0 };
}

// =============================================================================
// Uninstall
// =============================================================================

async function handleUninstall(sandboxRef: SandboxRef, args: (string | undefined)[]) {
  // Check for help
  if (args.includes("--help") || args.includes("-h")) {
    return {
      stdout: `Usage: sandlot uninstall <package> [...packages]

Examples:
  sandlot uninstall lodash
  sandlot uninstall react react-dom

Aliases: sandlot remove, sandlot rm
`,
      stderr: "",
      exitCode: 0,
    };
  }

  const packages = args.filter((a): a is string => !!a && !a.startsWith("-"));

  if (packages.length === 0) {
    return {
      stdout: "",
      stderr: `Usage: sandlot uninstall <package> [...packages]\n\nRun 'sandlot uninstall --help' for more information.\n`,
      exitCode: 1,
    };
  }

  const results: string[] = [];
  let hasError = false;

  for (const packageName of packages) {
    try {
      const result = await sandboxRef.uninstall(packageName);
      if (result.removed) {
        results.push(`- ${result.name}`);
      } else {
        results.push(`x ${packageName}: not installed`);
        hasError = true;
      }
    } catch (err) {
      hasError = true;
      const message = err instanceof Error ? err.message : String(err);
      results.push(`x ${packageName}: ${message}`);
    }
  }

  const output = results.join("\n") + "\n";

  return hasError
    ? { stdout: "", stderr: output, exitCode: 1 }
    : { stdout: output, stderr: "", exitCode: 0 };
}

// =============================================================================
// Run
// =============================================================================

async function handleRun(sandboxRef: SandboxRef, args: (string | undefined)[]) {
  let entryPoint: string | undefined;
  let skipTypecheck = false;
  let tailwind = false;
  let timeout = 30000;
  let entryExport: "main" | "default" = "main";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--skip-typecheck" || arg === "-s") {
      skipTypecheck = true;
    } else if (arg === "--tailwind") {
      tailwind = true;
    } else if ((arg === "--timeout" || arg === "-t") && args[i + 1]) {
      const t = parseInt(args[++i]!, 10);
      if (!isNaN(t)) timeout = t;
    } else if ((arg === "--entry" || arg === "-e") && args[i + 1]) {
      entryPoint = args[++i];
    } else if ((arg === "--export" || arg === "-x") && args[i + 1]) {
      const e = args[++i]!.toLowerCase();
      if (e === "main" || e === "default") {
        entryExport = e;
      }
    } else if (arg === "--help" || arg === "-h") {
      return {
        stdout: `Usage: sandlot run [options]

Options:
  --entry, -e <path>      Entry point (default: from package.json main)
  --skip-typecheck, -s    Skip type checking
  --tailwind              Enable Tailwind CSS processing
  --timeout, -t <ms>      Execution timeout (default: 30000, 0 = none)
  --export, -x <name>     Export to call: main or default (default: main)
  --help, -h              Show this help message

Examples:
  sandlot run
  sandlot run --entry /src/main.ts
  sandlot run --skip-typecheck --timeout 5000
  sandlot run --export default
`,
        stderr: "",
        exitCode: 0,
      };
    } else if (arg && !arg.startsWith("-") && !entryPoint) {
      entryPoint = arg;
    }
  }

  try {
    const result = await sandboxRef.run({
      entryPoint,
      skipTypecheck,
      tailwind,
      timeout,
      entryExport,
    });

    // Handle failure
    if (!result.success) {
      let stderr = "";

      // Build failure - use the shared formatter
      if (result.buildFailure) {
        stderr = formatBuildFailure(result.buildFailure, "Run failed");
      } else {
        // Execution failure
        stderr = `Run failed: ${result.error ?? "Unknown error"}\n`;
      }

      // Include any logs that were captured before failure
      let stdout = "";
      if (result.logs.length > 0) {
        stdout = result.logs.join("\n") + "\n";
      }

      return {
        stdout,
        stderr,
        exitCode: 1,
      };
    }

    // Success
    let output = "";

    // Output captured logs
    if (result.logs.length > 0) {
      output = result.logs.join("\n") + "\n";
    }

    // Output return value if present
    if (result.returnValue !== undefined) {
      const returnStr =
        typeof result.returnValue === "object"
          ? JSON.stringify(result.returnValue, null, 2)
          : String(result.returnValue);
      output += `[return] ${returnStr}\n`;
    }

    // Execution time
    if (result.executionTimeMs !== undefined) {
      output += `\nCompleted in ${result.executionTimeMs.toFixed(2)}ms\n`;
    }

    return {
      stdout: output,
      stderr: "",
      exitCode: 0,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: "",
      stderr: `Run error: ${message}\n`,
      exitCode: 1,
    };
  }
}

// =============================================================================
// Default Commands Factory
// =============================================================================

/**
 * Create all default sandbox commands.
 *
 * Currently just the `sandlot` command which dispatches to subcommands.
 */
export function createDefaultCommands(sandboxRef: SandboxRef) {
  return [createSandlotCommand(sandboxRef)];
}
