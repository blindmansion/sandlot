import { useState, useEffect, useRef, useMemo } from "react";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ReactDOM from "react-dom/client";
import { Group, Panel, Separator } from "react-resizable-panels";
import { createBrowserSandlot } from "sandlot/browser";
import type { Sandbox, BuildSuccess } from "sandlot";
import { Chat } from "./components/Chat";
import "./App.css";

/**
 * Generate the iframe HTML that will load and execute the bundled module.
 * The module runs inside the iframe context, so CSS injection targets the iframe's document.
 */
function generateIframeHtml(blobUrl: string): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      /* Minimal reset - just what's needed for a clean canvas */
      *, *::before, *::after { box-sizing: border-box; }
    </style>
  </head>
  <body>
    <div id="preview-root"></div>
    <script type="module">
      try {
        // Copy shared module registry from parent window to iframe's globalThis
        // The bundled code looks for the registry at globalThis["__sandlot_*__"]
        for (const key of Object.keys(window.parent)) {
          if (key.startsWith("__sandlot_") && key.endsWith("__")) {
            globalThis[key] = window.parent[key];
          }
        }
        
        const module = await import("${blobUrl}");
        
        // Look for a React component export
        const Component = module.default || module.App || module.MyComponent || module.Component;
        
        if (Component && typeof Component === "function") {
          // Access React and ReactDOM from parent window
          const React = window.parent.__SANDLOT_REACT__;
          const ReactDOM = window.parent.__SANDLOT_REACT_DOM__;
          
          if (!React || !ReactDOM) {
            throw new Error("React/ReactDOM not available from parent");
          }
          
          const root = ReactDOM.createRoot(document.getElementById("preview-root"));
          root.render(React.createElement(Component));
          
          // Signal success to parent
          window.parent.postMessage({ type: "preview-success" }, "*");
        } else {
          // No component found
          const exports = Object.keys(module).filter(k => k !== "__esModule");
          window.parent.postMessage({ 
            type: "preview-info",
            message: exports.length > 0 
              ? "Module loaded. Exports: " + exports.join(", ")
              : "Module loaded (no exports)"
          }, "*");
        }
      } catch (err) {
        window.parent.postMessage({ 
          type: "preview-error", 
          message: err.message || String(err)
        }, "*");
      }
    </script>
  </body>
</html>`;
}

/**
 * Preview panel that renders the latest build output in an isolated iframe.
 * The module executes inside the iframe, ensuring CSS injection targets the iframe's document.
 */
function Preview({ buildResult }: { buildResult: BuildSuccess | null }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Track error along with the build code it's associated with
  const [errorState, setErrorState] = useState<{ message: string; forCode: string } | null>(null);

  // Expose React and ReactDOM on window for iframe access
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__SANDLOT_REACT__ = React;
    (window as unknown as Record<string, unknown>).__SANDLOT_REACT_DOM__ = ReactDOM;
    
    return () => {
      delete (window as unknown as Record<string, unknown>).__SANDLOT_REACT__;
      delete (window as unknown as Record<string, unknown>).__SANDLOT_REACT_DOM__;
    };
  }, []);

  // Listen for messages from iframe
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!buildResult) return;
      
      if (event.data?.type === "preview-error") {
        setErrorState({ message: event.data.message, forCode: buildResult.code });
      } else if (event.data?.type === "preview-info") {
        setErrorState({ message: event.data.message, forCode: buildResult.code });
      } else if (event.data?.type === "preview-success") {
        setErrorState(null);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [buildResult]);

  // Create blob URL and iframe HTML, with cleanup on change
  const { iframeSrcDoc, blobUrl } = useMemo(() => {
    if (!buildResult) return { iframeSrcDoc: undefined, blobUrl: null };

    const blob = new Blob([buildResult.code], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);

    return {
      iframeSrcDoc: generateIframeHtml(url),
      blobUrl: url,
    };
  }, [buildResult]);

  // Cleanup blob URL when it changes
  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [blobUrl]);

  // Only show error if it's for the current build
  const error = errorState && errorState.forCode === buildResult?.code ? errorState.message : null;

  return (
    <div className="preview-panel">
      <div className="preview-content">
        {!buildResult && (
          <span className="preview-placeholder">
            Build output will appear here...
          </span>
        )}
        {error && <div className="preview-error">{error}</div>}
        <iframe
          ref={iframeRef}
          srcDoc={iframeSrcDoc}
          className="preview-iframe"
          title="Preview"
          sandbox="allow-scripts allow-same-origin allow-forms"
          style={{
            display: buildResult && !error ? "block" : "none",
          }}
        />
      </div>
    </div>
  );
}

function App() {
  const [sandbox, setSandbox] = useState<Sandbox | null>(null);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  const [latestBuild, setLatestBuild] = useState<BuildSuccess | null>(null);

  // Initialize sandlot and create sandbox
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    async function init() {
      try {
        const sandlot = await createBrowserSandlot({
          sharedModules: {
            react: React,
            "react/jsx-runtime": jsxRuntime,
            "react-dom/client": ReactDOM,
          },
        });
        const sb = await sandlot.createSandbox({
          initialFiles: {
            "/index.tsx": `import { useState } from 'react';

export function MyComponent() {
  const [count, setCount] = useState(0);
  
  return (
    <div className="p-6 bg-gradient-to-br from-purple-500 to-pink-500 rounded-xl text-white font-sans text-center shadow-lg">
      <h3 className="text-xl font-bold mb-4">Tailwind CSS Test</h3>
      <p className="mb-4 text-purple-100">
        If you see a purple-pink gradient with rounded corners - Tailwind works!
      </p>
      <div className="flex items-center justify-center gap-4">
        <button
          className="px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg text-lg font-bold transition-all"
          onClick={() => setCount((c) => c - 1)}
        >
          -
        </button>
        <span className="text-3xl font-bold min-w-[60px]">{count}</span>
        <button
          className="px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg text-lg font-bold transition-all"
          onClick={() => setCount((c) => c + 1)}
        >
          +
        </button>
      </div>
    </div>
  );
}`,
            "package.json": `{
  "name": "my-app",
  "version": "1.0.0",
  "main": "index.tsx",
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}`,
          },
        });

        // Listen for build events
        unsubscribe = sb.onBuild((result) => {
          if (!cancelled) {
            setLatestBuild(result);
          }
        });

        if (!cancelled) {
          setSandbox(sb);
        }
      } catch (err) {
        if (!cancelled) {
          setSandboxError(
            err instanceof Error ? err.message : "Failed to initialize sandbox",
          );
        }
      }
    }

    init();
    return () => {
      cancelled = true;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);

  return (
    <Group orientation="horizontal" className="panel-group">
      <Panel defaultSize={35} minSize={20} className="panel">
        <Chat sandbox={sandbox} sandboxError={sandboxError} />
      </Panel>
      <Separator className="resize-handle" />
      <Panel
        defaultSize={65}
        minSize={20}
        className="panel preview-panel-container"
      >
        <Preview buildResult={latestBuild} />
      </Panel>
    </Group>
  );
}

export default App;
