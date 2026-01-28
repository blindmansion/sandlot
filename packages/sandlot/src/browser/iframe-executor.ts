/**
 * Iframe executor for browser environments.
 *
 * This executor runs code in a sandboxed iframe, providing DOM isolation
 * and configurable security policies via the sandbox attribute.
 *
 * Key characteristics:
 * - Per-execution lifecycle: fresh iframe for each execute() call
 * - Configurable sandbox attributes (default: allow-scripts only)
 * - No shared module support (use MainThreadExecutor for that)
 * - Communication via postMessage
 */

import type { IExecutor, ExecuteOptions, ExecuteResult } from "../types";

/**
 * Options for creating an IframeExecutor.
 */
export interface IframeExecutorOptions {
  /**
   * Sandbox attributes for the iframe.
   * @default ["allow-scripts"]
   *
   * Common options:
   * - "allow-scripts": Required for code execution
   * - "allow-same-origin": Enables localStorage, cookies (reduces isolation)
   * - "allow-modals": Enables alert/confirm/prompt
   *
   * Security note: "allow-scripts" + "allow-same-origin" together allows
   * the iframe code to potentially remove the sandbox via script.
   */
  sandbox?: string[];

  /**
   * Default timeout in milliseconds.
   * @default 30000
   */
  defaultTimeout?: number;

  /**
   * Container element for iframes.
   * Iframes are created hidden (display: none).
   * @default document.body
   */
  container?: HTMLElement;
}

/**
 * Message types for parent -> iframe communication.
 */
interface ExecuteMessage {
  type: "execute";
  code: string;
  entryExport: "main" | "default";
  context: Record<string, unknown>;
}

/**
 * Message types for iframe -> parent communication.
 */
interface LogMessage {
  type: "log";
  level: "log" | "warn" | "error" | "info" | "debug";
  args: string;
}

interface ResultMessage {
  type: "result";
  success: boolean;
  returnValue?: unknown;
  error?: string;
}

interface ReadyMessage {
  type: "ready";
}

type IframeMessage = LogMessage | ResultMessage | ReadyMessage;

/**
 * Bootstrap HTML that runs inside the iframe.
 * This is injected via srcdoc and handles:
 * 1. Console capture and forwarding
 * 2. Code execution via Blob URL import
 * 3. Result reporting back to parent
 */
const BOOTSTRAP_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body>
<script type="module">
// Capture console methods and forward to parent
function formatArgs(...args) {
  return args
    .map(v => typeof v === "object" ? JSON.stringify(v) : String(v))
    .join(" ");
}

function createLogger(level) {
  return (...args) => {
    parent.postMessage({ type: "log", level, args: formatArgs(...args) }, "*");
  };
}

console.log = createLogger("log");
console.warn = createLogger("warn");
console.error = createLogger("error");
console.info = createLogger("info");
console.debug = createLogger("debug");

// Handle unhandled promise rejections
window.addEventListener("unhandledrejection", (event) => {
  const message = event.reason instanceof Error 
    ? event.reason.message 
    : String(event.reason);
  parent.postMessage({ 
    type: "result", 
    success: false, 
    error: "Unhandled promise rejection: " + message 
  }, "*");
});

// Handle uncaught errors
window.addEventListener("error", (event) => {
  parent.postMessage({ 
    type: "result", 
    success: false, 
    error: event.message || "Unknown error" 
  }, "*");
});

// Listen for execute messages from parent
window.addEventListener("message", async (event) => {
  if (event.data?.type !== "execute") return;

  const { code, entryExport, context } = event.data;

  try {
    // Create Blob URL and import as ESM module
    const blob = new Blob([code], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    
    let module;
    try {
      module = await import(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    // Execute the appropriate export
    let returnValue;

    if (entryExport === "main" && typeof module.main === "function") {
      returnValue = await module.main(context);
    } else if (entryExport === "default" && typeof module.default === "function") {
      returnValue = await module.default();
    } else if (entryExport === "default" && module.default !== undefined) {
      returnValue = module.default;
    }
    // If neither export exists, top-level code already ran on import

    parent.postMessage({ type: "result", success: true, returnValue }, "*");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parent.postMessage({ type: "result", success: false, error: message }, "*");
  }
});

// Signal that we're ready to receive code
parent.postMessage({ type: "ready" }, "*");
<\/script>
</body>
</html>`;

/**
 * Executor that runs code in a sandboxed iframe.
 *
 * Each execute() call creates a fresh iframe, runs the code, and destroys
 * the iframe. This provides clean isolation between executions.
 *
 * Note: This executor does NOT support shared modules. The iframe runs
 * in complete isolation. Use MainThreadExecutor if you need shared modules.
 *
 * @example
 * ```ts
 * // Default: strict sandboxing (allow-scripts only)
 * const executor = createIframeExecutor();
 *
 * // With additional permissions
 * const executor = createIframeExecutor({
 *   sandbox: ["allow-scripts", "allow-same-origin"],
 * });
 *
 * const result = await executor.execute(bundledCode, {
 *   entryExport: 'main',
 *   context: { args: ['--verbose'] },
 *   timeout: 5000,
 * });
 * console.log(result.logs);
 * ```
 */
export class IframeExecutor implements IExecutor {
  private options: Required<Omit<IframeExecutorOptions, "container">> & {
    container?: HTMLElement;
  };

  constructor(options: IframeExecutorOptions = {}) {
    this.options = {
      sandbox: options.sandbox ?? ["allow-scripts"],
      defaultTimeout: options.defaultTimeout ?? 30000,
      container: options.container,
    };
  }

  async execute(code: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    const {
      entryExport = "main",
      context = {},
      timeout = this.options.defaultTimeout,
    } = options;

    const startTime = performance.now();
    const logs: string[] = [];

    // Get container (default to document.body)
    const container = this.options.container ?? document.body;

    // Create iframe
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.sandbox.add(...this.options.sandbox);
    iframe.srcdoc = BOOTSTRAP_HTML;

    // Track whether we've received a result
    let resolved = false;

    return new Promise<ExecuteResult>((resolve) => {
      const cleanup = () => {
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe);
        }
        window.removeEventListener("message", handleMessage);
        if (timeoutId) clearTimeout(timeoutId);
      };

      const finish = (result: ExecuteResult) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(result);
      };

      // Handle messages from iframe
      const handleMessage = (event: MessageEvent) => {
        // Verify message is from our iframe
        if (event.source !== iframe.contentWindow) return;

        const data = event.data as IframeMessage;

        if (data.type === "log") {
          const prefix =
            data.level === "log" ? "" : `[${data.level}] `;
          logs.push(prefix + data.args);
        } else if (data.type === "result") {
          const executionTimeMs = performance.now() - startTime;
          finish({
            success: data.success,
            logs,
            returnValue: data.returnValue,
            error: data.error,
            executionTimeMs,
          });
        } else if (data.type === "ready") {
          // Iframe is ready, send the code to execute
          const message: ExecuteMessage = {
            type: "execute",
            code,
            entryExport,
            context,
          };
          iframe.contentWindow?.postMessage(message, "*");
        }
      };

      // Set up timeout
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          const executionTimeMs = performance.now() - startTime;
          finish({
            success: false,
            logs,
            error: `Execution timed out after ${timeout}ms`,
            executionTimeMs,
          });
        }, timeout);
      }

      // Listen for messages
      window.addEventListener("message", handleMessage);

      // Append iframe to DOM (this starts loading the srcdoc)
      container.appendChild(iframe);
    });
  }
}

/**
 * Create an iframe executor.
 *
 * @param options - Executor options
 * @returns A new IframeExecutor instance
 */
export function createIframeExecutor(
  options?: IframeExecutorOptions
): IframeExecutor {
  return new IframeExecutor(options);
}
