import type { IFileSystem } from "just-bash/browser";
import ts from "typescript";

/**
 * Options for type checking
 */
export interface TypecheckOptions {
  /**
   * The virtual filesystem to read source files from
   */
  fs: IFileSystem;

  /**
   * Entry point path (absolute path in the virtual filesystem).
   * TypeScript will discover all imported files from this root.
   */
  entryPoint: string;

  /**
   * Path to tsconfig.json in the virtual filesystem.
   * Default: "/tsconfig.json"
   */
  tsconfigPath?: string;

  /**
   * Pre-loaded TypeScript lib files (e.g., lib.dom.d.ts, lib.es2020.d.ts).
   * Map from lib name (e.g., "dom", "es2020") to file content.
   * If provided, enables proper type checking for built-in APIs.
   * Use fetchAndCacheLibs() from ts-libs to fetch these.
   */
  libFiles?: Map<string, string>;
}

/**
 * A single diagnostic message from type checking
 */
export interface Diagnostic {
  /**
   * File path where the error occurred (null for global errors)
   */
  file: string | null;

  /**
   * 1-based line number (null if not applicable)
   */
  line: number | null;

  /**
   * 1-based column number (null if not applicable)
   */
  column: number | null;

  /**
   * TypeScript error code (e.g., 2322 for type mismatch)
   */
  code: number;

  /**
   * Severity category
   */
  category: "error" | "warning" | "suggestion" | "message";

  /**
   * Human-readable error message
   */
  message: string;
}

/**
 * Result of type checking
 */
export interface TypecheckResult {
  /**
   * All diagnostics from type checking
   */
  diagnostics: Diagnostic[];

  /**
   * True if there are any errors (not just warnings)
   */
  hasErrors: boolean;

  /**
   * List of files that were checked
   */
  checkedFiles: string[];
}

/**
 * Map category enum to string
 */
function categoryToString(
  category: ts.DiagnosticCategory
): "error" | "warning" | "suggestion" | "message" {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    case ts.DiagnosticCategory.Message:
      return "message";
    default:
      return "error";
  }
}

/**
 * Convert TypeScript diagnostic to our Diagnostic format
 */
function convertDiagnostic(diag: ts.Diagnostic): Diagnostic {
  let file: string | null = null;
  let line: number | null = null;
  let column: number | null = null;

  if (diag.file && diag.start !== undefined) {
    file = diag.file.fileName;
    const pos = diag.file.getLineAndCharacterOfPosition(diag.start);
    line = pos.line + 1; // Convert to 1-based
    column = pos.character + 1; // Convert to 1-based
  }

  return {
    file,
    line,
    column,
    code: diag.code,
    category: categoryToString(diag.category),
    message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
  };
}

/**
 * Normalize path to absolute
 */
function normalizePath(path: string): string {
  if (!path.startsWith("/")) {
    return "/" + path;
  }
  return path;
}

/**
 * Pre-load files from the async filesystem into a sync cache
 */
async function preloadFiles(
  fs: IFileSystem
): Promise<Map<string, string>> {
  const cache = new Map<string, string>();
  const allPaths = fs.getAllPaths();

  for (const path of allPaths) {
    // Only cache TypeScript-related files
    if (
      path.endsWith(".ts") ||
      path.endsWith(".tsx") ||
      path.endsWith(".js") ||
      path.endsWith(".jsx") ||
      path.endsWith(".json") ||
      path.endsWith(".d.ts")
    ) {
      try {
        const stat = await fs.stat(path);
        if (stat.isFile) {
          const content = await fs.readFile(path);
          cache.set(path, content);
        }
      } catch {
        // Skip files that can't be read
      }
    }
  }

  return cache;
}

/**
 * Parse tsconfig.json and return compiler options
 *
 * @param configText - The content of tsconfig.json
 * @param _configPath - Path to the tsconfig (unused but kept for future reference resolution)
 */
function parseTsConfig(
  configText: string,
  _configPath: string
): ts.CompilerOptions {
  try {
    const config = JSON.parse(configText);
    const compilerOptions = config.compilerOptions || {};

    // Map string values to TypeScript enums
    const options: ts.CompilerOptions = {
      ...getDefaultCompilerOptions(),
    };

    // Target
    if (compilerOptions.target) {
      const targetMap: Record<string, ts.ScriptTarget> = {
        es5: ts.ScriptTarget.ES5,
        es6: ts.ScriptTarget.ES2015,
        es2015: ts.ScriptTarget.ES2015,
        es2016: ts.ScriptTarget.ES2016,
        es2017: ts.ScriptTarget.ES2017,
        es2018: ts.ScriptTarget.ES2018,
        es2019: ts.ScriptTarget.ES2019,
        es2020: ts.ScriptTarget.ES2020,
        es2021: ts.ScriptTarget.ES2021,
        es2022: ts.ScriptTarget.ES2022,
        esnext: ts.ScriptTarget.ESNext,
      };
      options.target = targetMap[compilerOptions.target.toLowerCase()] ?? ts.ScriptTarget.ES2020;
    }

    // Module
    if (compilerOptions.module) {
      const moduleMap: Record<string, ts.ModuleKind> = {
        commonjs: ts.ModuleKind.CommonJS,
        amd: ts.ModuleKind.AMD,
        umd: ts.ModuleKind.UMD,
        system: ts.ModuleKind.System,
        es6: ts.ModuleKind.ES2015,
        es2015: ts.ModuleKind.ES2015,
        es2020: ts.ModuleKind.ES2020,
        es2022: ts.ModuleKind.ES2022,
        esnext: ts.ModuleKind.ESNext,
        node16: ts.ModuleKind.Node16,
        nodenext: ts.ModuleKind.NodeNext,
      };
      options.module = moduleMap[compilerOptions.module.toLowerCase()] ?? ts.ModuleKind.ESNext;
    }

    // Module resolution
    if (compilerOptions.moduleResolution) {
      const resolutionMap: Record<string, ts.ModuleResolutionKind> = {
        classic: ts.ModuleResolutionKind.Classic,
        node: ts.ModuleResolutionKind.NodeJs,
        node10: ts.ModuleResolutionKind.NodeJs,
        node16: ts.ModuleResolutionKind.Node16,
        nodenext: ts.ModuleResolutionKind.NodeNext,
        bundler: ts.ModuleResolutionKind.Bundler,
      };
      options.moduleResolution =
        resolutionMap[compilerOptions.moduleResolution.toLowerCase()] ?? ts.ModuleResolutionKind.Bundler;
    }

    // JSX
    if (compilerOptions.jsx) {
      const jsxMap: Record<string, ts.JsxEmit> = {
        preserve: ts.JsxEmit.Preserve,
        react: ts.JsxEmit.React,
        "react-jsx": ts.JsxEmit.ReactJSX,
        "react-jsxdev": ts.JsxEmit.ReactJSXDev,
        "react-native": ts.JsxEmit.ReactNative,
      };
      options.jsx = jsxMap[compilerOptions.jsx.toLowerCase()] ?? ts.JsxEmit.ReactJSX;
    }

    // Boolean options
    if (compilerOptions.strict !== undefined) options.strict = compilerOptions.strict;
    if (compilerOptions.esModuleInterop !== undefined) options.esModuleInterop = compilerOptions.esModuleInterop;
    if (compilerOptions.skipLibCheck !== undefined) options.skipLibCheck = compilerOptions.skipLibCheck;
    if (compilerOptions.allowJs !== undefined) options.allowJs = compilerOptions.allowJs;
    if (compilerOptions.resolveJsonModule !== undefined) options.resolveJsonModule = compilerOptions.resolveJsonModule;
    if (compilerOptions.noImplicitAny !== undefined) options.noImplicitAny = compilerOptions.noImplicitAny;
    if (compilerOptions.strictNullChecks !== undefined) options.strictNullChecks = compilerOptions.strictNullChecks;
    // Note: noLib is intentionally not configurable - we always use our fetched lib files

    // Lib array (e.g., ["ES2020", "DOM"])
    if (Array.isArray(compilerOptions.lib)) {
      options.lib = compilerOptions.lib.map((lib: string) =>
        lib.toLowerCase().startsWith("lib.") ? lib : `lib.${lib.toLowerCase()}.d.ts`
      );
    }

    // Always ensure noEmit for type checking
    options.noEmit = true;

    return options;
  } catch (err) {
    console.warn("Error parsing tsconfig.json:", err);
    return getDefaultCompilerOptions();
  }
}

/**
 * Get default compiler options for type checking
 */
function getDefaultCompilerOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    strict: true,
    skipLibCheck: true, // Skip type-checking lib files for performance
    noEmit: true, // We only want type checking, no output
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    resolveJsonModule: true,
    noLib: false, // We provide lib files via the compiler host
    lib: [
      "lib.es2020.d.ts",
      "lib.dom.d.ts",
      "lib.dom.iterable.d.ts",
    ],
  };
}

/**
 * The virtual path where lib files are stored in the cache
 */
const LIB_PATH_PREFIX = "/node_modules/typescript/lib/";

/**
 * Create a custom compiler host that reads from the file cache
 * Note: We don't use ts.createCompilerHost as it requires Node.js fs module
 *
 * @param fileCache - Map of file paths to content (includes both user files and lib files)
 * @param libFiles - Map of lib names to content (e.g., "dom" -> content of lib.dom.d.ts)
 * @param _options - Compiler options (unused but kept for potential future use)
 */
function createVfsCompilerHost(
  fileCache: Map<string, string>,
  libFiles: Map<string, string>,
  _options: ts.CompilerOptions
): ts.CompilerHost {
  /**
   * Try to get content for a lib file request.
   * TypeScript may request libs by full path or just filename.
   */
  function getLibContent(fileName: string): string | undefined {
    // Extract lib name from various path formats:
    // - "/node_modules/typescript/lib/lib.dom.d.ts" -> "dom"
    // - "lib.dom.d.ts" -> "dom"
    const libMatch = fileName.match(/lib\.([^/]+)\.d\.ts$/);
    if (libMatch && libMatch[1]) {
      return libFiles.get(libMatch[1]);
    }
    return undefined;
  }

  return {
    getSourceFile(
      fileName: string,
      languageVersion: ts.ScriptTarget,
      onError?: (message: string) => void
    ): ts.SourceFile | undefined {
      // First, try the file cache (user files)
      const normalizedPath = normalizePath(fileName);
      const content = fileCache.get(normalizedPath);

      if (content !== undefined) {
        return ts.createSourceFile(normalizedPath, content, languageVersion, true);
      }

      // Try without leading slash
      const altContent = fileCache.get(fileName);
      if (altContent !== undefined) {
        return ts.createSourceFile(fileName, altContent, languageVersion, true);
      }

      // Try lib files
      const libContent = getLibContent(fileName);
      if (libContent !== undefined) {
        return ts.createSourceFile(fileName, libContent, languageVersion, true);
      }

      // File not found
      if (onError) {
        onError(`File not found: ${fileName}`);
      }
      return undefined;
    },

    getDefaultLibFileName(options: ts.CompilerOptions): string {
      return LIB_PATH_PREFIX + ts.getDefaultLibFileName(options);
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
      if (fileCache.has(normalizedPath) || fileCache.has(fileName)) {
        return true;
      }
      // Check if it's a lib file
      return getLibContent(fileName) !== undefined;
    },

    readFile(fileName: string): string | undefined {
      const normalizedPath = normalizePath(fileName);
      const content = fileCache.get(normalizedPath) ?? fileCache.get(fileName);
      if (content !== undefined) {
        return content;
      }
      // Try lib files
      return getLibContent(fileName);
    },

    directoryExists(directoryName: string): boolean {
      const normalizedDir = normalizePath(directoryName);

      // Check user files (includes installed packages in node_modules)
      for (const path of fileCache.keys()) {
        if (path.startsWith(normalizedDir + "/")) {
          return true;
        }
      }

      // Check if it's a TypeScript lib directory and we have lib files
      if (
        normalizedDir === "/node_modules/typescript/lib" ||
        normalizedDir === "/node_modules/typescript"
      ) {
        return libFiles.size > 0;
      }

      // Check /node_modules - exists if we have lib files OR installed packages
      if (normalizedDir === "/node_modules") {
        return libFiles.size > 0 || 
          Array.from(fileCache.keys()).some(p => p.startsWith("/node_modules/"));
      }

      // Check @types directory specifically
      if (normalizedDir === "/node_modules/@types") {
        return Array.from(fileCache.keys()).some(p => p.startsWith("/node_modules/@types/"));
      }

      return false;
    },

    getDirectories(path: string): string[] {
      const normalizedPath = normalizePath(path);
      const prefix = normalizedPath === "/" ? "/" : normalizedPath + "/";
      const dirs = new Set<string>();

      for (const filePath of fileCache.keys()) {
        if (filePath.startsWith(prefix)) {
          const relative = filePath.slice(prefix.length);
          const firstSlash = relative.indexOf("/");
          if (firstSlash > 0) {
            dirs.add(relative.slice(0, firstSlash));
          }
        }
      }

      // Add node_modules if we have lib files or packages and path is root
      if (normalizedPath === "/") {
        // Check if there are any files in node_modules (from packages or libs)
        const hasNodeModules = libFiles.size > 0 || 
          Array.from(fileCache.keys()).some(p => p.startsWith("/node_modules/"));
        if (hasNodeModules) {
          dirs.add("node_modules");
        }
      }

      return Array.from(dirs);
    },

    realpath(path: string): string {
      return path;
    },

    getEnvironmentVariable(): string | undefined {
      return undefined;
    },
  };
}

/**
 * Type check TypeScript files from a virtual filesystem
 *
 * @example
 * ```ts
 * const fs = Filesystem.create({
 *   initialFiles: {
 *     "/tsconfig.json": JSON.stringify({
 *       compilerOptions: {
 *         target: "ES2020",
 *         module: "ESNext",
 *         strict: true
 *       }
 *     }),
 *     "/src/index.ts": `
 *       const x: number = "hello"; // Type error!
 *       export { x };
 *     `,
 *   }
 * });
 *
 * const result = await typecheck({
 *   fs,
 *   entryPoint: "/src/index.ts",
 * });
 *
 * console.log(result.hasErrors); // true
 * console.log(result.diagnostics[0].message); // Type 'string' is not assignable...
 * ```
 */
export async function typecheck(options: TypecheckOptions): Promise<TypecheckResult> {
  const {
    fs,
    entryPoint,
    tsconfigPath = "/tsconfig.json",
    libFiles = new Map(),
  } = options;

  // Normalize entry point
  const normalizedEntry = normalizePath(entryPoint);

  // Verify entry point exists
  if (!(await fs.exists(normalizedEntry))) {
    throw new Error(`Entry point not found: ${normalizedEntry}`);
  }

  // Pre-load all files into sync cache
  const fileCache = await preloadFiles(fs);

  // Parse tsconfig if it exists
  let compilerOptions = getDefaultCompilerOptions();
  const tsconfigContent = fileCache.get(normalizePath(tsconfigPath));
  if (tsconfigContent) {
    compilerOptions = {
      ...parseTsConfig(tsconfigContent, tsconfigPath),
      noEmit: true, // Always ensure noEmit for type checking
    };
  }

  // Create compiler host with lib files
  const host = createVfsCompilerHost(fileCache, libFiles, compilerOptions);

  // Create program and get diagnostics
  const program = ts.createProgram([normalizedEntry], compilerOptions, host);

  // Collect all diagnostics
  const allDiagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...program.getDeclarationDiagnostics(),
  ];

  // Convert to our format
  const diagnostics = allDiagnostics.map(convertDiagnostic);

  // Get list of checked files
  const checkedFiles = program
    .getSourceFiles()
    .map((sf) => sf.fileName)
    .filter((f) => !f.includes("node_modules/typescript/lib"));

  // Check for errors
  const hasErrors = diagnostics.some((d) => d.category === "error");

  return {
    diagnostics,
    hasErrors,
    checkedFiles,
  };
}

/**
 * Format diagnostics as a human-readable string
 *
 * @example
 * ```ts
 * const result = await typecheck({ fs, entryPoint: "/src/index.ts" });
 * console.log(formatDiagnostics(result.diagnostics));
 * // /src/index.ts:3:7 - error TS2322: Type 'string' is not assignable to type 'number'.
 * ```
 */
export function formatDiagnostics(diagnostics: Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      const location = d.file
        ? `${d.file}${d.line ? `:${d.line}` : ""}${d.column ? `:${d.column}` : ""}`
        : "(global)";
      return `${location} - ${d.category} TS${d.code}: ${d.message}`;
    })
    .join("\n");
}

/**
 * Format diagnostics in a concise format suitable for AI agents
 *
 * @example
 * ```ts
 * const result = await typecheck({ fs, entryPoint: "/src/index.ts" });
 * console.log(formatDiagnosticsForAgent(result.diagnostics));
 * // Error in /src/index.ts at line 3: Type 'string' is not assignable to type 'number'. (TS2322)
 * ```
 */
export function formatDiagnosticsForAgent(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) {
    return "No type errors found.";
  }

  const errorCount = diagnostics.filter((d) => d.category === "error").length;
  const warningCount = diagnostics.filter((d) => d.category === "warning").length;

  const summary =
    errorCount > 0 || warningCount > 0
      ? `Found ${errorCount} error(s) and ${warningCount} warning(s):\n\n`
      : "";

  const formatted = diagnostics
    .map((d) => {
      const location = d.file
        ? `${d.file}${d.line ? ` at line ${d.line}` : ""}`
        : "Global";
      const prefix = d.category === "error" ? "Error" : d.category === "warning" ? "Warning" : "Info";
      return `${prefix} in ${location}: ${d.message} (TS${d.code})`;
    })
    .join("\n\n");

  return summary + formatted;
}
