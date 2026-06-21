/// <reference lib="dom" />
/**
 * Browser coding agent wired to pi-agent-core + the sandlot toolchain.
 *
 * Wiring (top to bottom):
 *   sandbox-core  — the toolchain (VFS + typecheck/bundle/install/run/render)
 *   browser-env   — an ExecutionEnv (FileSystem + Shell) over that core
 *   bash          — the Shell.exec implementation (string-parsing, no features)
 *   tools         — model-visible AgentTools (read/write/edit/ls/bash)
 *   Agent         — pi-agent-core's loop: tool-calling, streaming, abort
 *   streamFn      — streamSimple against OpenRouter, proxied via the dev server
 *
 * The provider request is proxied through the Bun dev server (`/api/openrouter`)
 * so the OpenRouter key stays server-side (see `serve.ts`); the browser sends a
 * placeholder key that the proxy overrides.
 */

import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { getModel, type Model, streamSimple } from "@earendil-works/pi-ai";
import { tokenize } from "./bash";
import { createBrowserEnv } from "./browser-env";
import { createSandboxCore } from "./sandbox-core";
import { createTools } from "./tools";

// ---------------------------------------------------------------------------
// Models. Each factory uses a literal id so `getModel` stays type-safe; we then
// repoint baseUrl at our same-origin proxy so the API key never reaches the
// browser.
// ---------------------------------------------------------------------------

const PROXY_BASE = `${location.origin}/api/openrouter`;

const DEFAULT_MODEL_ID = "anthropic/claude-sonnet-4.6";

const MODEL_FACTORIES: Record<string, () => Model<"openai-completions">> = {
	"anthropic/claude-sonnet-4.6": () =>
		getModel("openrouter", "anthropic/claude-sonnet-4.6"),
	"anthropic/claude-opus-4.8": () => getModel("openrouter", "anthropic/claude-opus-4.8"),
	"openai/gpt-5.1": () => getModel("openrouter", "openai/gpt-5.1"),
	"moonshotai/kimi-k2-thinking": () =>
		getModel("openrouter", "moonshotai/kimi-k2-thinking"),
	"qwen/qwen3-coder": () => getModel("openrouter", "qwen/qwen3-coder"),
};

function buildModel(id: string): Model<"openai-completions"> {
	const factory =
		MODEL_FACTORIES[id] ??
		(MODEL_FACTORIES[DEFAULT_MODEL_ID] as () => Model<"openai-completions">);
	return { ...factory(), baseUrl: PROXY_BASE };
}

// streamFn: inject a placeholder key (the proxy supplies the real one) and add
// OpenRouter's attribution headers. Must never throw — streamSimple already
// encodes request/model failures into the returned stream.
const streamFn: StreamFn = (model, context, options) =>
	streamSimple(model, context, {
		...options,
		apiKey: "sandlot-proxy",
		headers: {
			"HTTP-Referer": location.origin,
			"X-Title": "sandlot agent demo",
			...options?.headers,
		},
	});

const SYSTEM_PROMPT = `You are a coding agent working inside an in-browser virtual workspace.

The workspace is an in-memory filesystem rooted at "/". You edit TypeScript/TSX
projects and preview them live in an iframe that exposes a single mount host:
<div id="root"></div>.

Tools:
- read(path), write(path, content), edit(path, oldString, newString), ls(path)
- bash(command): a minimal shell with NO shell features (no pipes, redirection,
  globs, or chaining). Builtins: pwd, cd, ls, cat, echo, mkdir, rm, touch.
  Toolchain commands: typecheck, install [pkgs...], bundle <entry>, run <entry>,
  render <entry>.

Workflow:
1. Inspect the project with ls/read before editing.
2. Write code with write/edit. A starter app already lives at /src/index.ts and
   mounts into #root.
3. If you add dependencies, declare them in /package.json then run "install".
4. Run "typecheck" and fix reported errors.
5. Run "render /src/index.ts" to mount the app into the live preview. The entry
   should put its UI into document.getElementById("root").

Keep changes minimal and explain briefly what you did. Prefer plain DOM unless
asked otherwise; if you use a framework, install it first.`;

const STARTER_PACKAGE_JSON = `${JSON.stringify(
	{ name: "sandlot-agent-app", version: "0.0.0", private: true, dependencies: {} },
	null,
	2,
)}\n`;

const STARTER_INDEX = `const root = document.getElementById("root");
if (root) {
	root.innerHTML = \`
		<main style="font-family: system-ui, sans-serif; padding: 2rem; color: #111;">
			<h1 style="margin: 0 0 .5rem;">Hello from sandlot</h1>
			<p style="color:#555; margin: 0;">Ask the agent to change this app.</p>
		</main>\`;
}
`;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
	const el = document.getElementById(id);
	if (!el) throw new Error(`#${id} not found`);
	return el as T;
};

const renderFrame = $<HTMLIFrameElement>("render-frame");
const transcriptEl = $<HTMLDivElement>("transcript");
const inputEl = $<HTMLTextAreaElement>("input");
const composerEl = $<HTMLFormElement>("composer");
const sendBtn = $<HTMLButtonElement>("send");
const stopBtn = $<HTMLButtonElement>("stop");
const modelSelect = $<HTMLSelectElement>("model");
const statusEl = $<HTMLSpanElement>("status");
const previewPathEl = $<HTMLSpanElement>("preview-path");

function setStatus(text: string, kind: "" | "busy" | "error" = ""): void {
	statusEl.textContent = text;
	statusEl.className = `status${kind ? ` ${kind}` : ""}`;
}

for (const id of Object.keys(MODEL_FACTORIES)) {
	const opt = document.createElement("option");
	opt.value = id;
	opt.textContent = id;
	modelSelect.appendChild(opt);
}

// ---------------------------------------------------------------------------
// Toolchain + agent
// ---------------------------------------------------------------------------

const core = createSandboxCore(renderFrame);
const env = createBrowserEnv(core);
const tools = createTools(env);

const agent = new Agent({
	streamFn,
	initialState: {
		model: buildModel(modelSelect.value || "anthropic/claude-sonnet-4.6"),
		systemPrompt: SYSTEM_PROMPT,
		tools,
		thinkingLevel: "off",
	},
	// Gate obviously destructive commands before they run: refuse an `rm` that
	// targets the workspace root (`/` or `.`).
	beforeToolCall: async ({ toolCall, args }) => {
		if (toolCall.name === "bash") {
			const argv = tokenize((args as { command: string }).command);
			if (argv[0] === "rm") {
				const targets = argv.slice(1).filter((a) => !a.startsWith("-"));
				if (targets.some((t) => t === "/" || t === "." || t === "*")) {
					return {
						block: true,
						reason: "Refused: command would remove the workspace root.",
					};
				}
			}
		}
		return undefined;
	},
});

modelSelect.addEventListener("change", () => {
	agent.state.model = buildModel(modelSelect.value);
	setStatus(`model: ${modelSelect.value}`);
});

// ---------------------------------------------------------------------------
// Rendering the transcript
// ---------------------------------------------------------------------------

type AnyMessage = Agent["state"]["messages"][number];

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: "text"; text: string } => {
				return (c as { type?: string }).type === "text";
			})
			.map((c) => c.text)
			.join("");
	}
	return "";
}

function toolBlock(
	name: string,
	argSummary: string,
	state: "running" | "ok" | "error",
	output?: string,
): HTMLElement {
	const details = document.createElement("details");
	details.className = `tool${state === "error" ? " error" : ""}`;
	if (state !== "running" && output) details.open = false;

	const summary = document.createElement("summary");
	const glyph = document.createElement("span");
	glyph.className = "glyph";
	glyph.textContent = state === "error" ? "✗" : state === "ok" ? "✓" : "▸";
	const nameEl = document.createElement("span");
	nameEl.className = "name";
	nameEl.textContent = name;
	const argEl = document.createElement("span");
	argEl.className = "arg";
	argEl.textContent = argSummary;
	summary.append(glyph, nameEl, argEl);
	if (state === "running") {
		const spin = document.createElement("span");
		spin.className = "spinner";
		summary.appendChild(spin);
	}
	details.appendChild(summary);

	if (output) {
		const pre = document.createElement("pre");
		pre.textContent = output;
		details.appendChild(pre);
	}
	return details;
}

function argSummaryFor(name: string, args: Record<string, unknown>): string {
	if (name === "bash") return String(args.command ?? "");
	if (typeof args.path === "string") return args.path;
	return JSON.stringify(args);
}

function render(): void {
	const messages = agent.state.messages.slice() as AnyMessage[];
	const streaming = agent.state.streamingMessage as AnyMessage | undefined;
	if (streaming && agent.state.isStreaming && !messages.includes(streaming)) {
		messages.push(streaming);
	}

	const resultsByCall = new Map<string, AnyMessage & { role: "toolResult" }>();
	for (const m of messages) {
		if (m.role === "toolResult") resultsByCall.set(m.toolCallId, m);
	}

	transcriptEl.replaceChildren();

	if (messages.every((m) => m.role === "toolResult")) {
		const empty = document.createElement("div");
		empty.className = "empty";
		empty.textContent =
			"Ask me to build or modify the app on the right. I can edit files, install packages, typecheck, and render a live preview.";
		transcriptEl.appendChild(empty);
	}

	for (const m of messages) {
		if (m.role === "toolResult") continue; // rendered under its assistant call

		const wrap = document.createElement("div");
		wrap.className = `msg ${m.role}`;

		const role = document.createElement("div");
		role.className = "role";
		role.textContent = m.role;
		wrap.appendChild(role);

		if (m.role === "assistant" && m.stopReason === "error") {
			wrap.classList.add("error");
		}

		const body = messageText("content" in m ? m.content : "");
		const errorMsg = m.role === "assistant" ? m.errorMessage : undefined;
		if (body || errorMsg) {
			const bubble = document.createElement("div");
			bubble.className = "bubble";
			bubble.textContent = body || errorMsg || "";
			wrap.appendChild(bubble);
		}

		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const part of m.content) {
				if ((part as { type?: string }).type !== "toolCall") continue;
				const call = part as { id: string; name: string; arguments: Record<string, unknown> };
				const result = resultsByCall.get(call.id);
				const state = result ? (result.isError ? "error" : "ok") : "running";
				const output = result ? messageText(result.content) : undefined;
				wrap.appendChild(
					toolBlock(call.name, argSummaryFor(call.name, call.arguments), state, output),
				);
			}
		}

		transcriptEl.appendChild(wrap);
	}

	transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Agent lifecycle → UI
// ---------------------------------------------------------------------------

let running = false;

function setRunning(value: boolean): void {
	running = value;
	sendBtn.disabled = value;
	stopBtn.disabled = !value;
	if (value) setStatus("thinking…", "busy");
}

agent.subscribe((event) => {
	switch (event.type) {
		case "agent_start":
			setRunning(true);
			break;
		case "tool_execution_start":
			if (event.toolName === "render") {
				previewPathEl.textContent = String(
					(event.args as { command?: string }).command ?? "",
				).replace(/^render\s+/, "");
			}
			break;
		case "agent_end":
			setRunning(false);
			setStatus(`model: ${modelSelect.value}`);
			break;
	}
	render();
});

stopBtn.addEventListener("click", () => {
	agent.abort();
	setStatus("aborted", "error");
});

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function autoGrow(): void {
	inputEl.style.height = "auto";
	inputEl.style.height = `${Math.min(inputEl.scrollHeight, 180)}px`;
}
inputEl.addEventListener("input", autoGrow);

async function submit(): Promise<void> {
	const text = inputEl.value.trim();
	if (!text || running) return;
	inputEl.value = "";
	autoGrow();
	try {
		await agent.prompt(text);
	} catch (err) {
		setStatus(err instanceof Error ? err.message : "run failed", "error");
		setRunning(false);
	}
}

composerEl.addEventListener("submit", (e) => {
	e.preventDefault();
	void submit();
});

inputEl.addEventListener("keydown", (e) => {
	if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
		e.preventDefault();
		void submit();
	}
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
	setStatus("warming esbuild…", "busy");
	await core.ready();

	// Seed a minimal starter project and show it immediately so the preview
	// isn't blank and the agent has something concrete to edit.
	await core.writeFile("/package.json", STARTER_PACKAGE_JSON);
	await core.writeFile("/src/index.ts", STARTER_INDEX);
	previewPathEl.textContent = "/src/index.ts";
	await core.render("/src/index.ts");

	try {
		const res = await fetch("/api/config");
		const config = (await res.json()) as { hasKey?: boolean };
		if (!config.hasKey) {
			setStatus("set OPENROUTER_API_KEY in .env, then restart", "error");
			render();
			return;
		}
	} catch {
		// Non-fatal: proxy/config endpoint unavailable; surface at request time.
	}

	setStatus(`model: ${modelSelect.value}`);
	render();
	inputEl.focus();
}

void boot();
