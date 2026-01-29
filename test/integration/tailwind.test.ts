/**
 * Integration tests for Tailwind CSS processing
 */

import { describe, test, expect } from "bun:test";
import { withSandbox } from "../harness/index.ts";

describe("tailwind CSS", () => {
  const getSandbox = withSandbox();

  test("basic Tailwind CSS processing", async () => {
    const { sandbox } = getSandbox();

    sandbox.writeFile(
      "/tailwind-test.tsx",
      `// Component with Tailwind classes
export function Card() {
  return (
    <div className="p-4 bg-blue-500 text-white rounded-lg shadow-md hover:bg-blue-600 transition-colors">
      <h2 className="text-xl font-bold mb-2">Hello Tailwind</h2>
      <p className="text-sm opacity-80">This uses Tailwind CSS classes!</p>
      <button className="mt-4 px-4 py-2 bg-white text-blue-500 rounded hover:bg-gray-100">
        Click me
      </button>
    </div>
  );
}

console.log('Tailwind component defined');`
    );

    const buildResult = await sandbox.build({
      entryPoint: "/tailwind-test.tsx",
      skipTypecheck: true,
      tailwind: true,
    });

    expect(buildResult.success).toBe(true);

    // Check if Tailwind CSS was generated
    const hasBackgroundBlue =
      buildResult.code.includes("bg-blue-500") ||
      buildResult.code.includes("--tw-") ||
      buildResult.code.includes("background-color");
    const hasPadding =
      buildResult.code.includes("padding") || buildResult.code.includes("p-4");
    const hasStyleInjection =
      buildResult.code.includes("createElement") &&
      buildResult.code.includes("style");

    expect(hasBackgroundBlue || hasPadding).toBe(true);
    expect(hasStyleInjection).toBe(true);
  });

  test("shadcn-style path aliases and components", async () => {
    const { sandbox } = getSandbox();

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

    const UTILS_CODE = `import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`;

    const BUTTON_CODE = `import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium",
  {
    variants: {
      variant: {
        default: "bg-blue-600 text-white hover:bg-blue-700",
        destructive: "bg-red-600 text-white hover:bg-red-700",
        outline: "border-2 border-gray-300 bg-white text-gray-900 hover:bg-gray-100",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
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

    const APP_CODE = `import { Button } from "@/components/ui/button";

export default function App() {
  return (
    <div className="p-8 space-y-4">
      <h1 className="text-2xl font-bold text-blue-900">Test</h1>
      <div className="flex gap-2">
        <Button>Default (blue)</Button>
        <Button variant="destructive">Destructive (red)</Button>
        <Button variant="outline">Outline (white)</Button>
      </div>
    </div>
  );
}
`;

    // Write tsconfig with path aliases
    sandbox.writeFile("/tsconfig.json", JSON.stringify(TSCONFIG, null, 2));

    // Install dependencies
    const deps = [
      "clsx@2.1.1",
      "tailwind-merge@2.5.5",
      "class-variance-authority@0.7.1",
    ];
    for (const dep of deps) {
      await sandbox.install(dep);
    }

    // Write source files
    sandbox.writeFile("/src/lib/utils.ts", UTILS_CODE);
    sandbox.writeFile("/src/components/ui/button.tsx", BUTTON_CODE);
    sandbox.writeFile("/src/index.tsx", APP_CODE);

    // Update package.json
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
        2
      )
    );

    // Build with Tailwind
    const buildResult = await sandbox.build({
      tailwind: true,
      skipTypecheck: true,
    });

    expect(buildResult.success).toBe(true);
    expect(buildResult.code.length).toBeGreaterThan(0);

    // Check for path alias resolution
    const hasUtilsImport =
      buildResult.code.includes("twMerge") ||
      buildResult.code.includes("tailwind-merge");
    expect(hasUtilsImport).toBe(true);

    // Check for cva
    const hasCva =
      buildResult.code.includes("cva") ||
      buildResult.code.includes("class-variance-authority");
    expect(hasCva).toBe(true);

    // Check for style injection
    const hasStyleInjection =
      buildResult.code.includes("createElement") &&
      buildResult.code.includes("style");
    expect(hasStyleInjection).toBe(true);

    // Check for button variant strings in the bundle
    const variantsMatch = buildResult.code.match(/bg-blue-600[^"]*text-white/);
    expect(variantsMatch).not.toBeNull();
  });
});
