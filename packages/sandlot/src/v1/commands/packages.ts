/**
 * Package management commands: install, uninstall, list
 */

import { defineCommand, type CommandContext } from "just-bash/browser";
import { installPackage, uninstallPackage, listPackages } from "../packages";
import type { CommandDeps } from "./types";

/**
 * Create the `install` command for adding packages from npm
 */
export function createInstallCommand(deps: CommandDeps) {
  const { fs, typesCache } = deps;

  return defineCommand("install", async (args, _ctx: CommandContext) => {
    if (args.length === 0) {
      return {
        stdout: "",
        stderr: "Usage: install <package>[@version] [...packages]\n\nExamples:\n  install react\n  install lodash@4.17.21\n  install @tanstack/react-query@5\n",
        exitCode: 1,
      };
    }

    const results: string[] = [];
    let hasError = false;

    for (const packageSpec of args) {
      try {
        const result = await installPackage(fs, packageSpec!, { cache: typesCache });

        let status = `+ ${result.name}@${result.version}`;
        if (result.typesInstalled) {
          status += ` (${result.typeFilesCount} type file${result.typeFilesCount !== 1 ? "s" : ""})`;
          if (result.fromCache) {
            status += " [cached]";
          }
        } else if (result.typesError) {
          status += ` (no types: ${result.typesError})`;
        }
        results.push(status);
      } catch (err) {
        hasError = true;
        const message = err instanceof Error ? err.message : String(err);
        results.push(`x ${packageSpec}: ${message}`);
      }
    }

    const output = results.join("\n") + "\n";

    if (hasError) {
      return {
        stdout: "",
        stderr: output,
        exitCode: 1,
      };
    }

    return {
      stdout: output,
      stderr: "",
      exitCode: 0,
    };
  });
}

/**
 * Create the `uninstall` command for removing packages
 */
export function createUninstallCommand(deps: CommandDeps) {
  const { fs } = deps;

  return defineCommand("uninstall", async (args, _ctx: CommandContext) => {
    if (args.length === 0) {
      return {
        stdout: "",
        stderr: "Usage: uninstall <package> [...packages]\n",
        exitCode: 1,
      };
    }

    const results: string[] = [];
    let hasError = false;

    for (const packageName of args) {
      try {
        const removed = await uninstallPackage(fs, packageName!);
        if (removed) {
          results.push(`- ${packageName}`);
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

    if (hasError) {
      return {
        stdout: "",
        stderr: output,
        exitCode: 1,
      };
    }

    return {
      stdout: output,
      stderr: "",
      exitCode: 0,
    };
  });
}

/**
 * Create the `list` command (alias: `ls`) for showing installed packages
 */
export function createListCommand(deps: CommandDeps) {
  const { fs } = deps;

  return defineCommand("list", async (_args, _ctx: CommandContext) => {
    try {
      const packages = await listPackages(fs);

      if (packages.length === 0) {
        return {
          stdout: "No packages installed.\n",
          stderr: "",
          exitCode: 0,
        };
      }

      const output = packages
        .map((pkg) => `${pkg.name}@${pkg.version}`)
        .join("\n") + "\n";

      return {
        stdout: output,
        stderr: "",
        exitCode: 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: "",
        stderr: `Failed to list packages: ${message}\n`,
        exitCode: 1,
      };
    }
  });
}
