import {
  chat,
  toolDefinition,
  type ModelMessage,
  type StreamChunk,
} from "@tanstack/ai";
import { createOpenRouterText } from "@tanstack/ai-openrouter";
import { stream, type ConnectionAdapter } from "@tanstack/ai-client";
import type { Sandbox } from "sandlot";
import { z } from "zod";

/**
 * System prompt for the sandbox agent.
 * Explains how to build React components that render in the preview panel.
 */
const SYSTEM_PROMPT = `You are a helpful AI assistant that builds React components in a sandboxed environment.

## How It Works
You write React components that render live in a preview panel. When you modify files, the preview automatically updates.

## Component Export Convention
Your component must be exported with one of these names to render:
- \`export default MyComponent\`
- \`export function App() { ... }\`
- \`export function MyComponent() { ... }\`
- \`export function Component() { ... }\`

## React is Pre-installed
React is already available as a shared module. Import hooks and utilities normally:
\`\`\`tsx
import { useState, useEffect } from 'react';
\`\`\`
Do NOT run \`sandlot install react\` - it's already provided.

## Styling Options
1. **Tailwind CSS** - Use utility classes directly (e.g., \`className="p-4 bg-blue-500"\`)
   - After writing your component, run \`sandlot build --tailwind\` to process Tailwind classes
2. **CSS files** - Create \`.css\` files and import them
3. **Inline styles** - Use the \`style\` prop

## Installing Other Packages
For packages besides React, install them first:
\`\`\`
sandlot install lodash
sandlot install date-fns
\`\`\`

## Available Tools
- \`writeFile\` - Write/update files in the sandbox
- \`readFile\` - Read file contents
- \`exec\` - Run shell commands (bash basics + sandlot CLI)

## Example Workflow
1. Write your component to \`/index.tsx\`:
\`\`\`tsx
import { useState } from 'react';

export function MyComponent() {
  const [count, setCount] = useState(0);
  return (
    <button 
      className="px-4 py-2 bg-blue-500 text-white rounded"
      onClick={() => setCount(c => c + 1)}
    >
      Count: {count}
    </button>
  );
}
\`\`\`

2. Build with Tailwind to see it render:
\`\`\`
sandlot build --tailwind
\`\`\`

The component will appear in the preview panel with Tailwind styles applied.

IMPORTANT NOTE: The sandlot environment is under active development, particularly when it comes to typescript type resolution for certain packages. If you encounter a ts issue that looks odd, and not like a real issue, don't try to fix it, just tell the user what happened.`;

/**
 * Create tools that give the AI access to the sandbox
 */
function createSandboxTools(sandbox: Sandbox) {
  const writeFile = toolDefinition({
    name: "writeFile",
    description: "Write content to a file in the sandbox. Creates the file if it doesn't exist, overwrites if it does.",
    inputSchema: z.object({
      path: z.string().describe("The file path (e.g., '/index.ts' or '/src/app.tsx')"),
      content: z.string().describe("The content to write to the file"),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      path: z.string(),
    }),
  }).server(async (args: unknown) => {
    const { path, content } = args as { path: string; content: string };
    console.log("[tool:writeFile] input:", { path, content: content.slice(0, 100) + (content.length > 100 ? "..." : "") });
    sandbox.writeFile(path, content);
    const result = { success: true, path };
    console.log("[tool:writeFile] output:", result);
    return result;
  });

  const readFile = toolDefinition({
    name: "readFile",
    description: "Read the contents of a file from the sandbox",
    inputSchema: z.object({
      path: z.string().describe("The file path to read"),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      content: z.string().optional(),
      error: z.string().optional(),
    }),
  }).server(async (args: unknown) => {
    const { path } = args as { path: string };
    console.log("[tool:readFile] input:", { path });
    try {
      const content = sandbox.readFileRaw(path);
      const result = { success: true, content };
      console.log("[tool:readFile] output:", { success: true, content: content.slice(0, 100) + (content.length > 100 ? "..." : "") });
      return result;
    } catch (err) {
      const result = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
      console.log("[tool:readFile] output:", result);
      return result;
    }
  });

  // const run = toolDefinition({
  //   name: "run",
  //   description: "Build and execute TypeScript code in the sandbox. Returns console output and any return value from the 'main' export.",
  //   inputSchema: z.object({
  //     entryPoint: z.string().optional().describe("Optional entry point (defaults to /index.ts)"),
  //   }),
  //   outputSchema: z.object({
  //     success: z.boolean(),
  //     logs: z.array(z.string()),
  //     returnValue: z.unknown().optional(),
  //     error: z.string().optional(),
  //     executionTimeMs: z.number().optional(),
  //   }),
  // }).server(async (args: unknown) => {
  //   const { entryPoint } = args as { entryPoint?: string };
  //   console.log("[tool:run] input:", { entryPoint });
  //   const result = await sandbox.run({ entryPoint });
  //   const output = {
  //     success: result.success,
  //     logs: result.logs,
  //     returnValue: result.returnValue,
  //     error: result.error,
  //     executionTimeMs: result.executionTimeMs,
  //   };
  //   console.log("[tool:run] output:", output);
  //   return output;
  // });

  // const listFiles = toolDefinition({
  //   name: "listFiles",
  //   description: "List all files in the sandbox filesystem",
  //   inputSchema: z.object({}),
  //   outputSchema: z.object({
  //     files: z.array(z.string()),
  //   }),
  // }).server(async () => {
  //   console.log("[tool:listFiles] input:", {});
  //   const state = sandbox.getState();
  //   const result = { files: Object.keys(state.files) };
  //   console.log("[tool:listFiles] output:", result);
  //   return result;
  // });

  const exec = toolDefinition({
    name: "exec",
    description: "Execute a shell command in the sandbox. Supports standard bash commands (echo, cat, cd, ls, etc.) plus sandlot commands (sandlot build, sandlot install, etc.)",
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute"),
    }),
    outputSchema: z.object({
      exitCode: z.number(),
      stdout: z.string(),
      stderr: z.string(),
    }),
  }).server(async (args: unknown) => {
    const { command } = args as { command: string };
    console.log("[tool:exec] input:", { command });
    const result = await sandbox.exec(command);
    const output = {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    console.log("[tool:exec] output:", output);
    return output;
  });

  return [writeFile, readFile, exec];
}

export function createInProcessAdapter(
  apiKey: string,
  sandbox: Sandbox,
): ConnectionAdapter {
  const textAdapter = createOpenRouterText("anthropic/claude-sonnet-4.5", apiKey);
  const tools = createSandboxTools(sandbox);

  return stream((messages: ModelMessage[]) => {
    const chatStream = chat({
      adapter: textAdapter,
      // @ts-expect-error - ModelMessage is compatible at runtime; strict multimodal typing causes mismatch
      messages,
      tools,
      systemPrompts: [SYSTEM_PROMPT],
      agentLoopStrategy: ({ iterationCount }) => iterationCount < 100,
    });

    return chatStream as AsyncIterable<StreamChunk>;
  });
}
