/**
 * Test script for shadcn-style path aliases and Tailwind CSS
 * 
 * Run with: bun run test-shadcn.ts
 */

import { createNodeSandlot } from "sandlot/node";

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
      "@/*": ["./src/*"]
    }
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

async function main() {
  console.log("Creating sandlot...");
  const sandlot = await createNodeSandlot();

  console.log("Creating sandbox...");
  const sandbox = await sandlot.createSandbox();

  // Write tsconfig with path aliases
  console.log("\n📁 Writing tsconfig.json with path aliases...");
  sandbox.writeFile("/tsconfig.json", JSON.stringify(TSCONFIG, null, 2));

  // Install dependencies
  console.log("\n📦 Installing dependencies...");
  const deps = ["clsx@2.1.1", "tailwind-merge@2.5.5", "class-variance-authority@0.7.1"];
  for (const dep of deps) {
    const result = await sandbox.install(dep);
    console.log(`  + ${result.name}@${result.version}`);
  }

  // Write source files
  console.log("\n📝 Writing source files...");
  sandbox.writeFile("/src/lib/utils.ts", UTILS_CODE);
  console.log("  /src/lib/utils.ts");
  sandbox.writeFile("/src/components/ui/button.tsx", BUTTON_CODE);
  console.log("  /src/components/ui/button.tsx");
  sandbox.writeFile("/src/index.tsx", APP_CODE);
  console.log("  /src/index.tsx");

  // Update package.json
  sandbox.writeFile("/package.json", JSON.stringify({
    main: "./src/index.tsx",
    dependencies: {
      clsx: "2.1.1",
      "tailwind-merge": "2.5.5",
      "class-variance-authority": "0.7.1",
    }
  }, null, 2));

  // Build with Tailwind
  console.log("\n🔨 Building with Tailwind enabled...");
  const buildResult = await sandbox.build({
    tailwind: true,
    skipTypecheck: true,
  });

  if (!buildResult.success) {
    console.error("\n❌ Build failed!");
    console.error("Phase:", buildResult.phase);
    if (buildResult.bundleErrors) {
      for (const err of buildResult.bundleErrors) {
        console.error("  Error:", err.text);
        if (err.location) {
          console.error("    at", err.location.file, "line", err.location.line);
        }
      }
    }
    await sandlot.dispose();
    process.exit(1);
  }

  console.log("\n✅ Build successful!");
  console.log(`Bundle size: ${(buildResult.code.length / 1024).toFixed(2)} KB`);
  console.log(`Files included: ${buildResult.includedFiles.join(", ")}`);

  // Analyze the output
  console.log("\n📊 Analyzing bundle...");
  
  // Check for path alias resolution
  const hasUtilsImport = buildResult.code.includes("twMerge") || buildResult.code.includes("tailwind-merge");
  console.log(`  ✓ cn() utility resolved: ${hasUtilsImport}`);
  
  // Check for cva
  const hasCva = buildResult.code.includes("cva") || buildResult.code.includes("class-variance-authority");
  console.log(`  ✓ cva resolved: ${hasCva}`);

  // Check for Tailwind CSS
  const hasTailwindCSS = buildResult.code.includes("bg-blue-600") || buildResult.code.includes("#2563eb");
  console.log(`  ✓ Tailwind classes in bundle: ${hasTailwindCSS}`);

  // Look for generated CSS (style injection)
  const hasStyleInjection = buildResult.code.includes("createElement") && buildResult.code.includes("style");
  console.log(`  ✓ Style injection code: ${hasStyleInjection}`);

  // Print a section of the bundle to see what's happening
  console.log("\n📜 First 2000 chars of bundle:");
  console.log("─".repeat(60));
  console.log(buildResult.code.slice(0, 2000));
  console.log("─".repeat(60));

  // Search for CSS-related content
  console.log("\n🔍 Searching for CSS content...");
  const cssMatch = buildResult.code.match(/\.bg-blue-600[^}]*\}/);
  if (cssMatch) {
    console.log("  Found bg-blue-600 CSS rule:", cssMatch[0].slice(0, 100));
  } else {
    console.log("  ⚠️  No bg-blue-600 CSS rule found in bundle");
  }

  // Check if buttonVariants object is in the bundle
  const variantsMatch = buildResult.code.match(/bg-blue-600[^"]*text-white/);
  if (variantsMatch) {
    console.log("  Found button variant string:", variantsMatch[0]);
  }

  await sandlot.dispose();
  console.log("\n✅ Done!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
