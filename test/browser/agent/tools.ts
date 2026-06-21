/**
 * Model-visible tools for the browser coding agent.
 *
 * Each is an {@link AgentTool}: a typebox-schema'd tool whose `execute()` calls
 * into the {@link ExecutionEnv}. Per pi-agent-core's contract, `execute()`
 * throws on failure (the loop converts the throw into an error tool result),
 * while the env methods return `Result` — so we unwrap and throw on `!ok`.
 *
 * The set is intentionally small and coding-focused: read/write/edit files,
 * list a directory, and run the virtual `bash` (which is also how the agent
 * reaches the toolchain: `typecheck`, `install`, `bundle`, `run`, `render`).
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { ExecutionEnv } from "@earendil-works/pi-agent-core";

function text(content: string) {
	return [{ type: "text" as const, text: content }];
}

/** Identity helper so each tool's `execute` params infer from its `parameters` schema. */
function defineTool<T extends TSchema>(tool: AgentTool<T>): AgentTool<T> {
	return tool;
}

export function createTools(env: ExecutionEnv): AgentTool<any>[] {
	const read = defineTool({
		name: "read",
		label: "Read file",
		description:
			"Read a UTF-8 text file from the workspace. Path is absolute or relative to the current directory.",
		parameters: Type.Object({
			path: Type.String({ description: "File path to read." }),
		}),
		execute: async (_id, { path }) => {
			const res = await env.readTextFile(path);
			if (!res.ok) throw new Error(`read failed: ${res.error.code}: ${res.error.message}`);
			return { content: text(res.value), details: { path } };
		},
	});

	const write = defineTool({
		name: "write",
		label: "Write file",
		description:
			"Create or overwrite a file with the given contents, creating parent directories as needed.",
		parameters: Type.Object({
			path: Type.String({ description: "File path to write." }),
			content: Type.String({ description: "Full file contents." }),
		}),
		execute: async (_id, { path, content }) => {
			const res = await env.writeFile(path, content);
			if (!res.ok) throw new Error(`write failed: ${res.error.code}: ${res.error.message}`);
			return {
				content: text(`Wrote ${path} (${content.length} chars).`),
				details: { path, bytes: content.length },
			};
		},
	});

	const edit = defineTool({
		name: "edit",
		label: "Edit file",
		description:
			"Replace the first occurrence of `oldString` with `newString` in a file. `oldString` must appear exactly once unless `replaceAll` is true.",
		parameters: Type.Object({
			path: Type.String({ description: "File path to edit." }),
			oldString: Type.String({ description: "Exact text to find." }),
			newString: Type.String({ description: "Replacement text." }),
			replaceAll: Type.Optional(
				Type.Boolean({ description: "Replace every occurrence. Default false." }),
			),
		}),
		execute: async (_id, { path, oldString, newString, replaceAll }) => {
			const res = await env.readTextFile(path);
			if (!res.ok) throw new Error(`edit failed: ${res.error.code}: ${res.error.message}`);
			const original = res.value;
			const count = oldString === "" ? 0 : original.split(oldString).length - 1;
			if (count === 0) throw new Error(`edit failed: oldString not found in ${path}`);
			if (count > 1 && !replaceAll) {
				throw new Error(
					`edit failed: oldString occurs ${count} times in ${path}; pass replaceAll or add more context.`,
				);
			}
			const updated = replaceAll
				? original.split(oldString).join(newString)
				: original.replace(oldString, newString);
			const writeRes = await env.writeFile(path, updated);
			if (!writeRes.ok) {
				throw new Error(`edit failed: ${writeRes.error.code}: ${writeRes.error.message}`);
			}
			return {
				content: text(`Edited ${path} (${replaceAll ? count : 1} replacement(s)).`),
				details: { path, replacements: replaceAll ? count : 1 },
			};
		},
	});

	const ls = defineTool({
		name: "ls",
		label: "List directory",
		description: "List the entries of a directory in the workspace.",
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({ description: "Directory path. Defaults to the current directory." }),
			),
		}),
		execute: async (_id, { path }) => {
			const res = await env.listDir(path ?? ".");
			if (!res.ok) throw new Error(`ls failed: ${res.error.code}: ${res.error.message}`);
			const lines = res.value.map(
				(e) => `${e.kind === "directory" ? "d" : "-"} ${e.name}`,
			);
			return {
				content: text(lines.length > 0 ? lines.join("\n") : "(empty)"),
				details: { entries: res.value.map((e) => e.name) },
			};
		},
	});

	const bash = defineTool({
		name: "bash",
		label: "Run command",
		description:
			"Run a command in the virtual workspace shell. No shell features (pipes, redirection, globs). " +
			"Filesystem: pwd, cd, ls, cat, echo, mkdir, rm, touch. " +
			"Toolchain: typecheck, install [pkgs...], bundle <entry>, run <entry>, render <entry>. " +
			"Use `render <entry>` to mount a view into the live preview iframe.",
		parameters: Type.Object({
			command: Type.String({ description: "The command line to execute." }),
		}),
		execute: async (_id, { command }, signal) => {
			const res = await env.exec(command, { abortSignal: signal });
			if (!res.ok) throw new Error(`exec failed: ${res.error.code}: ${res.error.message}`);
			const { stdout, stderr, exitCode } = res.value;
			const parts = [
				stdout.trimEnd(),
				stderr.trimEnd() && `stderr:\n${stderr.trimEnd()}`,
				`exit ${exitCode}`,
			].filter(Boolean);
			return {
				content: text(parts.join("\n")),
				details: { exitCode },
			};
		},
	});

	return [read, write, edit, ls, bash];
}
