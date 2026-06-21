/**
 * A deliberately tiny "bash": pure string parsing, no shell features.
 *
 * There are no pipes, redirections, globs, subshells, variable expansion, or
 * command chaining — a command line is tokenized (respecting single/double
 * quotes) into `argv` and dispatched to a flat command table. That keeps the
 * surface small and predictable while still being enough for a coding agent to
 * drive the sandlot toolchain: navigate and edit the in-memory filesystem, then
 * `typecheck` / `install` / `bundle` / `run` / `render` the project.
 *
 * Each command returns a {@link CommandResult} (`stdout`, `stderr`, `exitCode`).
 * The {@link createBash} factory closes over a {@link SandboxCore} and a mutable
 * `cwd`, and returns an `exec(command)` the {@link createBrowserEnv} Shell wraps.
 */

import { basename, dirname, normalize } from "../../../src/toolchain/util";
import type { Diagnostic } from "../../../src/toolchain/typecheck";
import type { SandboxCore } from "./sandbox-core";

export interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface Bash {
	/** Current working directory (absolute, normalized). */
	readonly cwd: string;
	/** Set the working directory (kept in sync with the owning {@link ExecutionEnv}). */
	setCwd(path: string): void;
	/** Parse and run a single command line. Never throws; errors become stderr + nonzero exit. */
	exec(command: string, signal?: AbortSignal): Promise<CommandResult>;
}

const ok = (stdout = ""): CommandResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string, exitCode = 1): CommandResult => ({
	stdout: "",
	stderr,
	exitCode,
});

/**
 * Tokenize a command line into argv. Supports single and double quotes and a
 * backslash escape; everything else (pipes, `>`, `&&`, `$VAR`, `*`) is treated
 * as a literal character — this shell has no such features by design.
 */
export function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let hasCurrent = false;
	let quote: '"' | "'" | null = null;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i] as string;
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else if (ch === "\\" && quote === '"' && i + 1 < input.length) {
				current += input[++i];
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			hasCurrent = true;
			continue;
		}
		if (ch === "\\" && i + 1 < input.length) {
			current += input[++i];
			hasCurrent = true;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\n") {
			if (hasCurrent) {
				tokens.push(current);
				current = "";
				hasCurrent = false;
			}
			continue;
		}
		current += ch;
		hasCurrent = true;
	}
	if (hasCurrent) tokens.push(current);
	return tokens;
}

/** Split argv into option flags (`-x`, grouped like `-rf`) and positionals. */
function parseArgs(argv: string[]): { flags: Set<string>; positionals: string[] } {
	const flags = new Set<string>();
	const positionals: string[] = [];
	for (const arg of argv) {
		if (arg.startsWith("--")) {
			flags.add(arg.slice(2));
		} else if (arg.startsWith("-") && arg.length > 1) {
			for (const ch of arg.slice(1)) flags.add(ch);
		} else {
			positionals.push(arg);
		}
	}
	return { flags, positionals };
}

function formatDiagnostic(d: Diagnostic): string {
	const loc =
		d.line !== undefined && d.column !== undefined
			? `${d.file}:${d.line}:${d.column}`
			: d.file;
	return `${d.category} TS${d.code}: ${loc} - ${d.message}`;
}

export function createBash(core: SandboxCore, initialCwd = "/"): Bash {
	let cwd = normalize(initialCwd);

	const resolve = (p: string): string =>
		normalize(p.startsWith("/") ? p : `${cwd === "/" ? "" : cwd}/${p}`);

	type Handler = (
		argv: string[],
		signal?: AbortSignal,
	) => Promise<CommandResult> | CommandResult;

	const commands: Record<string, Handler> = {
		pwd: () => ok(`${cwd}\n`),

		echo: (argv) => ok(`${argv.join(" ")}\n`),

		async cd(argv) {
			const target = resolve(argv[0] ?? "/");
			if (!(await core.fs.exists(target))) {
				return fail(`cd: ${argv[0]}: No such file or directory\n`);
			}
			const stat = await core.fs.stat(target);
			if (!stat.isDirectory) return fail(`cd: ${argv[0]}: Not a directory\n`);
			cwd = target;
			return ok();
		},

		async ls(argv) {
			const { flags, positionals } = parseArgs(argv);
			const long = flags.has("l");
			const all = flags.has("a");
			const target = resolve(positionals[0] ?? ".");
			if (!(await core.fs.exists(target))) {
				return fail(`ls: ${positionals[0] ?? "."}: No such file or directory\n`);
			}
			const stat = await core.fs.stat(target);
			if (!stat.isDirectory) return ok(`${basename(target)}\n`);
			let names = await core.fs.readdir(target);
			if (!all) names = names.filter((n) => !n.startsWith("."));
			if (names.length === 0) return ok();
			if (!long) return ok(`${names.join("\n")}\n`);
			const lines: string[] = [];
			for (const name of names) {
				const childPath = target === "/" ? `/${name}` : `${target}/${name}`;
				const childStat = await core.fs.stat(childPath);
				const kind = childStat.isDirectory ? "d" : "-";
				lines.push(`${kind} ${name}`);
			}
			return ok(`${lines.join("\n")}\n`);
		},

		async cat(argv) {
			if (argv.length === 0) return fail("cat: missing file operand\n");
			let out = "";
			let stderr = "";
			let exitCode = 0;
			for (const arg of argv) {
				const path = resolve(arg);
				if (!(await core.fs.exists(path))) {
					stderr += `cat: ${arg}: No such file or directory\n`;
					exitCode = 1;
					continue;
				}
				const stat = await core.fs.stat(path);
				if (stat.isDirectory) {
					stderr += `cat: ${arg}: Is a directory\n`;
					exitCode = 1;
					continue;
				}
				out += await core.fs.readFile(path);
			}
			return { stdout: out, stderr, exitCode };
		},

		async mkdir(argv) {
			const { flags, positionals } = parseArgs(argv);
			if (positionals.length === 0) return fail("mkdir: missing operand\n");
			const recursive = flags.has("p");
			let stderr = "";
			let exitCode = 0;
			for (const arg of positionals) {
				try {
					await core.fs.mkdir(resolve(arg), { recursive });
				} catch (err) {
					stderr += `mkdir: ${arg}: ${(err as Error).message}\n`;
					exitCode = 1;
				}
			}
			return { stdout: "", stderr, exitCode };
		},

		async rm(argv) {
			const { flags, positionals } = parseArgs(argv);
			if (positionals.length === 0) return fail("rm: missing operand\n");
			const recursive = flags.has("r") || flags.has("R") || flags.has("recursive");
			const force = flags.has("f") || flags.has("force");
			let stderr = "";
			let exitCode = 0;
			for (const arg of positionals) {
				try {
					await core.removePath(resolve(arg), { recursive, force });
				} catch (err) {
					if (!force) {
						stderr += `rm: ${arg}: ${(err as Error).message}\n`;
						exitCode = 1;
					}
				}
			}
			return { stdout: "", stderr, exitCode };
		},

		async touch(argv) {
			if (argv.length === 0) return fail("touch: missing file operand\n");
			for (const arg of argv) {
				const path = resolve(arg);
				if (!(await core.fs.exists(path))) await core.writeFile(path, "");
			}
			return ok();
		},

		async typecheck() {
			const report = await core.typecheck();
			const header = `${report.errorCount} error(s), ${report.warningCount} warning(s)\n`;
			if (report.diagnostics.length === 0) return ok(header);
			const body = report.diagnostics.map(formatDiagnostic).join("\n");
			return {
				stdout: `${header}${body}\n`,
				stderr: "",
				exitCode: report.errorCount > 0 ? 1 : 0,
			};
		},

		async install(argv) {
			const { positionals } = parseArgs(argv);
			const installed = await core.install(
				positionals.length > 0 ? positionals : undefined,
			);
			if (installed.length === 0) return ok("No packages to install.\n");
			const lines = installed.map((p) => `+ ${p.name}@${p.version}`);
			return ok(`${lines.join("\n")}\n`);
		},

		async bundle(argv) {
			const { positionals } = parseArgs(argv);
			const entry = positionals[0];
			if (!entry) return fail("bundle: missing entry point\n");
			const result = await core.bundle(resolve(entry));
			const size = new TextEncoder().encode(result.code).length;
			const lines = [
				`bundled ${result.inputs.length} module(s), ${size} bytes` +
					(result.css ? ` (+${result.css.length} bytes css)` : ""),
				...result.inputs.map((i) => `  ${i}`),
			];
			return ok(`${lines.join("\n")}\n`);
		},

		async run(argv) {
			const { positionals } = parseArgs(argv);
			const entry = positionals[0];
			if (!entry) return fail("run: missing entry point\n");
			const report = await core.run(resolve(entry));
			return execReportToResult(report);
		},

		async render(argv) {
			const { positionals } = parseArgs(argv);
			const entry = positionals[0];
			if (!entry) return fail("render: missing entry point\n");
			const report = await core.render(resolve(entry));
			const base = execReportToResult(report);
			if (base.exitCode === 0) {
				base.stdout = `rendered ${entry} into the preview iframe.\n${base.stdout}`;
			}
			return base;
		},
	};

	return {
		get cwd() {
			return cwd;
		},
		setCwd(path) {
			cwd = normalize(path.startsWith("/") ? path : `/${path}`);
		},
		async exec(command, signal) {
			const argv = tokenize(command);
			if (argv.length === 0) return ok();
			const name = argv[0] as string;
			const handler = commands[name];
			if (!handler) {
				return fail(
					`${name}: command not found. Available: ${Object.keys(commands)
						.sort()
						.join(", ")}\n`,
					127,
				);
			}
			try {
				return await handler(argv.slice(1), signal);
			} catch (err) {
				return fail(`${name}: ${(err as Error).message}\n`);
			}
		},
	};
}

function execReportToResult(report: {
	ok: boolean;
	log: Array<{ level: string; text: string }>;
	error?: { message: string; name?: string };
}): CommandResult {
	const stdout = report.log
		.filter((l) => l.level !== "error" && l.level !== "warn")
		.map((l) => l.text)
		.join("\n");
	const logErrors = report.log
		.filter((l) => l.level === "error" || l.level === "warn")
		.map((l) => l.text);
	const errParts = [...logErrors];
	if (report.error) {
		errParts.push(
			`${report.error.name ? `${report.error.name}: ` : ""}${report.error.message}`,
		);
	}
	return {
		stdout: stdout ? `${stdout}\n` : "",
		stderr: errParts.length > 0 ? `${errParts.join("\n")}\n` : "",
		exitCode: report.ok ? 0 : 1,
	};
}
