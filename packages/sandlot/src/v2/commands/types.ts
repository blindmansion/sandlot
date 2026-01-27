/**
 * Types and utilities for v2 sandbox bash commands.
 *
 * Commands wrap the sandbox's direct methods to provide a shell interface.
 * This ensures consistency between `sandbox.build()` and `sandbox.exec('sandlot build')`.
 */

import type {
  Filesystem,
  InstallResult,
  UninstallResult,
  BuildResult,
  TypecheckResult,
  SandboxBuildOptions,
  SandboxTypecheckOptions,
  BundleError,
  Diagnostic,
} from "../types";

/**
 * Reference to sandbox methods that commands can call.
 *
 * Commands receive this interface rather than raw dependencies,
 * ensuring they use the same logic as direct API calls.
 */
export interface SandboxRef {
  /** The virtual filesystem */
  readonly fs: Filesystem;

  /** Install a package */
  install(packageSpec: string): Promise<InstallResult>;

  /** Uninstall a package */
  uninstall(packageName: string): Promise<UninstallResult>;

  /** Build the project */
  build(options?: SandboxBuildOptions): Promise<BuildResult>;

  /** Type check the project */
  typecheck(options?: SandboxTypecheckOptions): Promise<TypecheckResult>;
}

/**
 * Format a file size in bytes to a human-readable string
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Format diagnostics for shell output
 */
export function formatDiagnostics(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return "";

  return diagnostics
    .map((d) => {
      const severity = d.severity.toUpperCase();
      if (d.file) {
        const loc = `${d.file}${d.line ? `:${d.line}` : ""}${d.column ? `:${d.column}` : ""}`;
        return `${severity}: ${loc}: ${d.message}`;
      }
      return `${severity}: ${d.message}`;
    })
    .join("\n");
}

/**
 * Format bundle errors for shell output
 */
export function formatBundleErrors(errors: BundleError[]): string {
  if (errors.length === 0) return "";

  return errors
    .map((e) => {
      let output = "";

      // Location header
      if (e.location) {
        const loc = `${e.location.file}:${e.location.line}${e.location.column ? `:${e.location.column}` : ""}`;
        output += `ERROR: ${loc}: ${e.text}`;

        // Show source line if available
        if (e.location.lineText) {
          output += `\n    ${e.location.line} | ${e.location.lineText}`;
          // Add caret pointing to column
          if (e.location.column) {
            const padding = " ".repeat(
              String(e.location.line).length + 3 + e.location.column - 1
            );
            output += `\n${padding}^`;
          }
        }
      } else {
        output += `ERROR: ${e.text}`;
      }

      return output;
    })
    .join("\n\n");
}
