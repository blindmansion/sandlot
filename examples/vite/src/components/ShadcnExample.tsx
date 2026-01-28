import { useState, useEffect, useRef } from "react";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ReactDOM from "react-dom/client";
import type { Sandlot, Diagnostic, BundleError } from "sandlot";
import { createBrowserSandlot } from "sandlot/browser";

// Format type check diagnostics for display
function formatDiagnostics(diagnostics: Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      const loc =
        d.file && d.line
          ? `${d.file}:${d.line}${d.column ? `:${d.column}` : ""}`
          : "";
      const prefix =
        d.severity === "error"
          ? "error"
          : d.severity === "warning"
            ? "warning"
            : "info";
      return loc
        ? `${loc} - ${prefix}: ${d.message}`
        : `${prefix}: ${d.message}`;
    })
    .join("\n");
}

// Format bundle errors for display
function formatBundleErrors(errors: BundleError[]): string {
  return errors
    .map((e) => {
      if (e.location) {
        const loc = `${e.location.file}:${e.location.line}${e.location.column ? `:${e.location.column}` : ""}`;
        let msg = `${loc}: ${e.text}`;
        if (e.location.lineText) {
          msg += `\n    ${e.location.lineText}`;
        }
        return msg;
      }
      return e.text;
    })
    .join("\n\n");
}

// The code that will run in the sandbox - demonstrates shadcn-style setup
const DEMO_CODE = `// This demonstrates shadcn-style imports with:
// - tsconfig path aliases (@/ -> /src/)
// - Tailwind CSS + class-variance-authority (cva)
// - cn() utility function

import { Button } from "@/components/ui/button";

export default function App() {
  return (
    <div className="p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">
          shadcn/ui Button
        </h1>
        <p className="text-slate-600 mt-1">
          Using cva for variants, just like the real shadcn/ui
        </p>
      </div>
      
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button>Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Link</Button>
          <Button variant="destructive">Destructive</Button>
        </div>
        
        <div className="flex flex-wrap gap-2">
          <Button size="sm">Small</Button>
          <Button size="default">Default</Button>
          <Button size="lg">Large</Button>
        </div>
      </div>
    </div>
  );
}
`;

// The cn() utility (from shadcn)
const UTILS_CODE = `import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`;

// A Button component using cva (authentic shadcn pattern)
// Using more distinct colors to make variants obvious
const BUTTON_CODE = `import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-blue-600 text-white hover:bg-blue-700",
        destructive: "bg-red-600 text-white hover:bg-red-700",
        outline: "border-2 border-gray-300 bg-white text-gray-900 hover:bg-gray-100",
        secondary: "bg-gray-200 text-gray-900 hover:bg-gray-300",
        ghost: "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
        link: "text-blue-600 underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({
  className,
  variant,
  size,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
`;

// tsconfig with path aliases
const TSCONFIG = {
  compilerOptions: {
    target: "ES2020",
    lib: ["ES2020", "DOM", "DOM.Iterable"],
    module: "ESNext",
    moduleResolution: "bundler",
    jsx: "react-jsx",
    strict: true,
    noEmit: true,
    esModuleInterop: true,
    skipLibCheck: true,
    baseUrl: ".",
    paths: {
      "@/*": ["./src/*"],
    },
  },
  include: ["**/*.ts", "**/*.tsx"],
};

export function ShadcnExample() {
  const [code, setCode] = useState(DEMO_CODE);
  const [output, setOutput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const renderContainerRef = useRef<HTMLDivElement | null>(null);
  const reactRootRef = useRef<ReactDOM.Root | null>(null);
  const sandlotRef = useRef<Sandlot | null>(null);

  // Initialize sandlot once on mount with React shared
  useEffect(() => {
    createBrowserSandlot({
      sharedModules: {
        react: React,
        "react/jsx-runtime": jsxRuntime,
        "react-dom/client": ReactDOM,
      },
    }).then((sandlot) => {
      sandlotRef.current = sandlot;
    });
  }, []);

  // Cleanup React root on unmount
  useEffect(() => {
    return () => {
      if (reactRootRef.current) {
        reactRootRef.current.unmount();
      }
    };
  }, []);

  const runCode = async () => {
    setIsRunning(true);
    setOutput("");

    // Clear previous render
    if (renderContainerRef.current) {
      renderContainerRef.current.innerHTML = "";
    }

    try {
      // Ensure sandlot is initialized
      if (!sandlotRef.current) {
        sandlotRef.current = await createBrowserSandlot({
          sharedModules: {
            react: React,
            "react/jsx-runtime": jsxRuntime,
            "react-dom/client": ReactDOM,
          },
        });
      }

      // Create a fresh sandbox for each run
      const sandbox = await sandlotRef.current.createSandbox();

      // Install required packages for shadcn utilities
      setOutput("Installing dependencies...");
      await sandbox.install("clsx@2.1.1");
      await sandbox.install("tailwind-merge@2.5.5");
      await sandbox.install("class-variance-authority@0.7.1");

      // Write tsconfig with path aliases
      sandbox.writeFile("/tsconfig.json", JSON.stringify(TSCONFIG, null, 2));

      // Write the utility files
      sandbox.writeFile("/src/lib/utils.ts", UTILS_CODE);
      sandbox.writeFile("/src/components/ui/button.tsx", BUTTON_CODE);

      // Write the main app code
      sandbox.writeFile("/src/index.tsx", code);

      // Update package.json to use the correct entry point
      sandbox.writeFile(
        "/package.json",
        JSON.stringify(
          {
            main: "./src/index.tsx",
            dependencies: {
              clsx: "2.1.1",
              "tailwind-merge": "2.5.5",
              "class-variance-authority": "0.7.1",
            },
          },
          null,
          2,
        ),
      );

      setOutput("Building with Tailwind...");

      // Build with tailwind enabled
      const buildResult = await sandbox.build({
        tailwind: true,
        // skipTypecheck: true, // Skip for demo speed
      });

      if (!buildResult.success) {
        let errorOutput = `Build failed in ${buildResult.phase} phase:\n\n`;
        switch (buildResult.phase) {
          case "entry":
            errorOutput += buildResult.message ?? "Entry point not found";
            break;
          case "typecheck":
            if (buildResult.diagnostics && buildResult.diagnostics.length > 0) {
              errorOutput += formatDiagnostics(buildResult.diagnostics);
            }
            break;
          case "bundle":
            if (
              buildResult.bundleErrors &&
              buildResult.bundleErrors.length > 0
            ) {
              errorOutput += formatBundleErrors(buildResult.bundleErrors);
            }
            break;
        }
        setOutput(errorOutput);
        return;
      }

      // Build succeeded - load the module and render
      if (!renderContainerRef.current) {
        setOutput("Error: Render container not found");
        return;
      }

      // Load the bundled module via blob URL
      const blob = new Blob([buildResult.code], {
        type: "application/javascript",
      });
      const url = URL.createObjectURL(blob);

      try {
        const module = await import(/* @vite-ignore */ url);
        const App = module.default;

        if (!App) {
          setOutput(
            "Error: No default export found. Export your component as default.",
          );
          return;
        }

        // Unmount previous root if exists
        if (reactRootRef.current) {
          reactRootRef.current.unmount();
        }

        // Create a new React root and render
        const root = ReactDOM.createRoot(renderContainerRef.current);
        reactRootRef.current = root;
        root.render(React.createElement(App));

        // Show success info
        const logs: string[] = [];
        logs.push("[Path Aliases: @/* -> /src/*]");
        logs.push("[Tailwind CSS: enabled]");
        logs.push(
          "[Shared Modules: react, react/jsx-runtime, react-dom/client]",
        );
        logs.push("");
        logs.push("Component rendered successfully!");
        logs.push(
          `Bundle size: ${(buildResult.code.length / 1024).toFixed(2)} KB`,
        );

        setOutput(logs.join("\n"));
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setOutput(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="example-card">
      <h2>shadcn-style Components</h2>
      <p className="description">
        Demonstrates tsconfig path aliases (<code>@/</code> → <code>/src/</code>
        ) and Tailwind CSS. Uses a shadcn-style <code>cn()</code> utility and
        Button component.
      </p>
      <textarea
        className="code-editor"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        spellCheck={false}
        style={{ minHeight: "200px" }}
      />
      <div className="button-row">
        <button onClick={runCode} disabled={isRunning}>
          {isRunning ? "Building..." : "Build & Render"}
        </button>
      </div>
      <div className="output-label">Preview</div>
      <div
        ref={renderContainerRef}
        className="render-container"
        style={{
          minHeight: "120px",
          padding: "16px",
          backgroundColor: "#fff",
          border: "1px solid #e2e8f0",
          borderRadius: "8px",
        }}
      >
        <span style={{ color: "#999", fontStyle: "italic" }}>
          Click "Build &amp; Render" to see the component...
        </span>
      </div>
      <div className="output-label" style={{ marginTop: "8px" }}>
        Status
      </div>
      <div
        className={`output-panel ${output.includes("Error") ? "error" : ""}`}
      >
        {output || "Click 'Build & Render' to see the component..."}
      </div>
    </div>
  );
}
