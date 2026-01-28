/**
 * Typechecker - TypeScript type checking.
 *
 * Uses TypeScript's compiler API
 * Fetches TypeScript lib files (lib.dom.d.ts, etc.) from CDN and caches them.
 */

import ts from "typescript";
import type { Filesystem } from "./fs";
import type {
  ITypechecker,
  TypecheckOptions,
  TypecheckResult,
  Diagnostic,
} from "../types";

// =============================================================================
// Configuration
// =============================================================================

/** TypeScript version to fetch libs for - should match package.json */
const TS_VERSION = "5.9.3";

/** CDN base URL for TypeScript lib files */
const DEFAULT_CDN_BASE = `https://cdn.jsdelivr.net/npm/typescript@${TS_VERSION}/lib`;

/** Default libs for environment */
const DEFAULT_LIBS = ["es2020", "dom", "dom.iterable"];

/** Virtual path where lib files are "located" for TypeScript */
const LIB_PATH_PREFIX = "/node_modules/typescript/lib/";

// =============================================================================
// Types
// =============================================================================

export interface TypecheckerOptions {
  /**
   * TypeScript lib names to include (e.g., "dom", "es2020").
   * If not provided, uses sensible defaults: ["es2020", "dom", "dom.iterable"]
   */
  libs?: string[];

  /**
   * Base URL to fetch TypeScript lib files from.
   * Defaults to jsDelivr CDN.
   */
  libsBaseUrl?: string;
}

// =============================================================================
// Lib File Fetching
// =============================================================================

/**
 * Parse `/// <reference lib="..." />` directives from a lib file.
 */
function parseLibReferences(content: string): string[] {
  const refs: string[] = [];
  const regex = /\/\/\/\s*<reference\s+lib="([^"]+)"\s*\/>/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    if (match[1]) {
      refs.push(match[1]);
    }
  }

  return refs;
}

/**
 * Convert a lib name to its filename.
 * e.g., "es2020" -> "lib.es2020.d.ts"
 */
function libNameToFileName(name: string): string {
  return `lib.${name}.d.ts`;
}

/**
 * Fetch a single lib file from CDN.
 */
async function fetchLibFile(name: string, baseUrl: string): Promise<string> {
  const fileName = libNameToFileName(name);
  const url = `${baseUrl}/${fileName}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

/**
 * Fetch all lib files, following reference directives.
 */
async function fetchAllLibs(
  libs: string[],
  baseUrl: string
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const pending = new Set<string>(libs);
  const fetched = new Set<string>();

  while (pending.size > 0) {
    const batch = Array.from(pending);
    pending.clear();

    const results = await Promise.all(
      batch.map(async (name) => {
        if (fetched.has(name)) {
          return { name, content: null };
        }
        fetched.add(name);

        try {
          const content = await fetchLibFile(name, baseUrl);
          return { name, content };
        } catch (err) {
          console.warn(`[typechecker] Failed to fetch lib.${name}.d.ts:`, err);
          return { name, content: null };
        }
      })
    );

    for (const { name, content } of results) {
      if (content === null) continue;

      result.set(name, content);

      // Parse references and queue unfetched ones
      const refs = parseLibReferences(content);
      for (const ref of refs) {
        if (!fetched.has(ref) && !pending.has(ref)) {
          pending.add(ref);
        }
      }
    }
  }

  return result;
}

// =============================================================================
// Compiler Host
// =============================================================================

/**
 * Normalize a path to absolute form.
 */
function normalizePath(path: string): string {
  if (!path.startsWith("/")) {
    return "/" + path;
  }
  return path;
}

/**
 * Get lib content from the lib cache.
 * Handles various path formats TypeScript might request.
 */
function getLibContent(
  fileName: string,
  libFiles: Map<string, string>
): string | undefined {
  // Extract lib name from path: "lib.dom.d.ts" or "/node_modules/typescript/lib/lib.dom.d.ts"
  const match = fileName.match(/lib\.([^/]+)\.d\.ts$/);
  if (match?.[1]) {
    return libFiles.get(match[1]);
  }
  return undefined;
}

/**
 * Create a TypeScript compiler host that reads from our filesystem.
 */
function createCompilerHost(
  fs: Filesystem,
  libFiles: Map<string, string>,
  options: ts.CompilerOptions
): ts.CompilerHost {
  return {
    getSourceFile(
      fileName: string,
      languageVersion: ts.ScriptTarget,
      onError?: (message: string) => void
    ): ts.SourceFile | undefined {
      // Try filesystem first (user files + node_modules with package types)
      const normalizedPath = normalizePath(fileName);

      try {
        if (fs.exists(normalizedPath)) {
          const stat = fs.stat(normalizedPath);
          if (stat.isFile) {
            const content = fs.readFileRaw(normalizedPath);
            return ts.createSourceFile(normalizedPath, content, languageVersion, true);
          }
        }
      } catch {
        // Not found in filesystem, continue to lib files
      }

      // Try without leading slash
      try {
        if (fs.exists(fileName)) {
          const stat = fs.stat(fileName);
          if (stat.isFile) {
            const content = fs.readFileRaw(fileName);
            return ts.createSourceFile(fileName, content, languageVersion, true);
          }
        }
      } catch {
        // Not found, continue
      }

      // Try lib files
      const libContent = getLibContent(fileName, libFiles);
      if (libContent !== undefined) {
        return ts.createSourceFile(fileName, libContent, languageVersion, true);
      }

      if (onError) {
        onError(`File not found: ${fileName}`);
      }
      return undefined;
    },

    getDefaultLibFileName(opts: ts.CompilerOptions): string {
      return LIB_PATH_PREFIX + ts.getDefaultLibFileName(opts);
    },

    writeFile(): void {
      // No-op: we don't emit files
    },

    getCurrentDirectory(): string {
      return "/";
    },

    getCanonicalFileName(fileName: string): string {
      return fileName;
    },

    useCaseSensitiveFileNames(): boolean {
      return true;
    },

    getNewLine(): string {
      return "\n";
    },

    fileExists(fileName: string): boolean {
      const normalizedPath = normalizePath(fileName);

      // Check filesystem
      try {
        if (fs.exists(normalizedPath)) {
          return fs.stat(normalizedPath).isFile;
        }
      } catch {
        // Not found
      }

      // Check lib files
      return getLibContent(fileName, libFiles) !== undefined;
    },

    readFile(fileName: string): string | undefined {
      const normalizedPath = normalizePath(fileName);

      // Try filesystem
      try {
        if (fs.exists(normalizedPath)) {
          return fs.readFileRaw(normalizedPath);
        }
      } catch {
        // Not found
      }

      // Try lib files
      return getLibContent(fileName, libFiles);
    },

    directoryExists(directoryName: string): boolean {
      const normalizedDir = normalizePath(directoryName);

      // Check filesystem directly - it tracks directories!
      try {
        if (fs.exists(normalizedDir)) {
          return fs.stat(normalizedDir).isDirectory;
        }
      } catch {
        // Not found
      }

      // Virtual directories for lib files
      if (
        normalizedDir === "/node_modules/typescript/lib" ||
        normalizedDir === "/node_modules/typescript" ||
        normalizedDir === "/node_modules"
      ) {
        return libFiles.size > 0;
      }

      return false;
    },

    getDirectories(path: string): string[] {
      const normalizedPath = normalizePath(path);

      try {
        if (!fs.exists(normalizedPath)) {
          return [];
        }

        const stat = fs.stat(normalizedPath);
        if (!stat.isDirectory) {
          return [];
        }

        // Use readdir and filter to directories
        const entries = fs.readdir(normalizedPath);
        const dirs: string[] = [];

        for (const name of entries) {
          const childPath =
            normalizedPath === "/" ? `/${name}` : `${normalizedPath}/${name}`;
          try {
            if (fs.stat(childPath).isDirectory) {
              dirs.push(name);
            }
          } catch {
            // Skip if can't stat
          }
        }

        return dirs;
      } catch {
        return [];
      }
    },

    realpath(path: string): string {
      return path;
    },

    getEnvironmentVariable(): string | undefined {
      return undefined;
    },
  };
}

// =============================================================================
// tsconfig Parsing
// =============================================================================

/**
 * Get default compiler options for TypeScript.
 */
function getDefaultCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    resolveJsonModule: true,
    lib: ["lib.es2020.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  };
}

/**
 * Parse tsconfig.json content into compiler options.
 *
 * Uses TypeScript's built-in parsing instead of manual enum mapping.
 */
function parseTsConfig(
  fs: Filesystem,
  configPath: string
): ts.CompilerOptions {
  try {
    if (!fs.exists(configPath)) {
      return getDefaultCompilerOptions();
    }

    const configText = fs.readFileRaw(configPath);
    const { config, error } = ts.parseConfigFileTextToJson(configPath, configText);

    if (error) {
      console.warn("[typechecker] Error parsing tsconfig:", error.messageText);
      return getDefaultCompilerOptions();
    }

    // Create a minimal parse host for config parsing
    const parseHost: ts.ParseConfigHost = {
      useCaseSensitiveFileNames: true,
      readDirectory: () => [],
      fileExists: (path) => fs.exists(normalizePath(path)),
      readFile: (path) => {
        try {
          return fs.readFileRaw(normalizePath(path));
        } catch {
          return undefined;
        }
      },
    };

    const parsed = ts.parseJsonConfigFileContent(
      config,
      parseHost,
      "/", // base path
      undefined, // existing options
      configPath
    );

    // Filter out "no inputs found" error (TS18003) - we pass entry points explicitly
    const relevantErrors = parsed.errors.filter((e) => e.code !== 18003);
    if (relevantErrors.length > 0) {
      console.warn(
        "[typechecker] tsconfig parse errors:",
        relevantErrors.map((e) => e.messageText)
      );
    }

    // Ensure noEmit is always true for type checking
    return {
      ...parsed.options,
      noEmit: true,
    };
  } catch (err) {
    console.warn("[typechecker] Error reading tsconfig:", err);
    return getDefaultCompilerOptions();
  }
}

// =============================================================================
// Diagnostic Conversion
// =============================================================================

/**
 * Convert TypeScript diagnostic category to our severity.
 */
function categoryToSeverity(
  category: ts.DiagnosticCategory
): "error" | "warning" | "info" {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    default:
      return "info";
  }
}

/**
 * Convert TypeScript diagnostic to our format.
 */
function convertDiagnostic(diag: ts.Diagnostic): Diagnostic {
  let file: string | undefined;
  let line: number | undefined;
  let column: number | undefined;

  if (diag.file && diag.start !== undefined) {
    file = diag.file.fileName;
    const pos = diag.file.getLineAndCharacterOfPosition(diag.start);
    line = pos.line + 1; // Convert to 1-based
    column = pos.character + 1;
  }

  return {
    file,
    line,
    column,
    message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
    severity: categoryToSeverity(diag.category),
  };
}

// =============================================================================
// Typechecker
// =============================================================================

/**
 * Typechecker using TypeScript compiler API.
 *
 * Fetches TypeScript lib files from CDN and caches them.
 * Uses filesystem access for efficient type checking.
 *
 * @example
 * ```ts
 * const typechecker = new Typechecker();
 *
 * const result = await typechecker.typecheck({
 *   fs: myFilesystem,
 *   entryPoint: "/src/index.ts",
 * });
 *
 * if (!result.success) {
 *   console.log("Type errors:", result.diagnostics);
 * }
 * ```
 */
export class Typechecker implements ITypechecker {
  private options: TypecheckerOptions;
  private libCache: Map<string, string> = new Map();
  private initPromise: Promise<void> | null = null;

  constructor(options: TypecheckerOptions = {}) {
    this.options = options;
  }

  /**
   * Pre-fetch TypeScript lib files.
   * Called automatically on first typecheck() if not already done.
   */
  async initialize(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    if (this.libCache.size > 0) {
      return; // Already initialized
    }

    this.initPromise = this.fetchLibs();
    await this.initPromise;
  }

  private async fetchLibs(): Promise<void> {
    const libs = this.options.libs ?? DEFAULT_LIBS;
    const baseUrl = this.options.libsBaseUrl ?? DEFAULT_CDN_BASE;

    console.log(`[typechecker] Fetching TypeScript libs: ${libs.join(", ")}...`);
    const fetched = await fetchAllLibs(libs, baseUrl);
    console.log(`[typechecker] Fetched ${fetched.size} lib files`);

    this.libCache = fetched;
  }

  /**
   * Type check files in a filesystem.
   */
  async typecheck(options: TypecheckOptions): Promise<TypecheckResult> {
    await this.initialize();

    const { fs, entryPoint, tsconfigPath = "/tsconfig.json" } = options;
    const normalizedEntry = normalizePath(entryPoint);

    // Verify entry point exists
    if (!fs.exists(normalizedEntry)) {
      return {
        success: false,
        diagnostics: [
          {
            file: normalizedEntry,
            message: `Entry point not found: ${normalizedEntry}`,
            severity: "error",
          },
        ],
      };
    }

    // Parse tsconfig
    const compilerOptions = parseTsConfig(fs, tsconfigPath);

    // Create compiler host
    const host = createCompilerHost(fs, this.libCache, compilerOptions);

    // Create program and collect diagnostics
    const program = ts.createProgram([normalizedEntry], compilerOptions, host);

    const allDiagnostics = [
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
      ...program.getDeclarationDiagnostics(),
    ];

    // Convert diagnostics
    const diagnostics = allDiagnostics.map(convertDiagnostic);

    // Check for errors
    const success = !diagnostics.some((d) => d.severity === "error");

    return {
      success,
      diagnostics,
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a typechecker instance.
 */
export function createTypechecker(
  options?: TypecheckerOptions
): ITypechecker {
  return new Typechecker(options);
}
