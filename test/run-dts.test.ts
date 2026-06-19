/**
 * Verifies that host-function `dts` signatures can be surfaced to the
 * typechecker as ambient globals.
 *
 * The flow under test:
 *   host functions  --generateHostFunctionDts-->  .d.ts string
 *   .d.ts string    --globalDeclarations-------->  typecheck environment
 *
 * Once injected, guest source that references `Sand.fs.*` typechecks against
 * the real signatures (and mistakes are caught), even though `Sand` is a
 * runtime-injected global that exists nowhere in the project's files.
 *
 * Lib files are loaded from the local TypeScript install (no network), so this
 * runs deterministically under `bun test`.
 */

import { createDefaultMapFromNodeModules } from "@typescript/vfs";
import { expect, test } from "bun:test";
import ts from "typescript";
import {
	createSandHostFunctions,
	generateHostFunctionDts,
} from "../src/host-functions";
import { MemoryUnionFs } from "./helpers/memory-fs";
import { runTypecheck, summarizeDiagnostics } from "../src/toolchain/typecheck";

const DECL_PATH = "/__sandlot_globals__.d.ts";

/** TypeScript lib files from the locally installed `typescript` package. */
function loadLocalLibs(): Map<string, string> {
	return createDefaultMapFromNodeModules(
		{ target: ts.ScriptTarget.ES2020 },
		ts,
	);
}

/** The ambient declarations generated from the Sand host functions. */
function sandDeclarations(fs: MemoryUnionFs): Map<string, string> {
	const dts = generateHostFunctionDts(createSandHostFunctions({ fs }), {
		async: true,
	});
	return new Map([[DECL_PATH, dts]]);
}

/** Source that uses an injected global host function correctly. */
const GOOD_SOURCE = [
	"async function main(): Promise<number> {",
	'\tconst text = await Sand.fs.readFile("/data.txt");',
	"\treturn text.length;",
	"}",
	"export {};",
	"",
].join("\n");

test("without injected declarations, host globals are unresolved", async () => {
	const fs = new MemoryUnionFs({ "/src/index.ts": GOOD_SOURCE });

	const { diagnostics } = await runTypecheck({
		fs,
		mode: "run",
		compilerOptions: { strict: true },
		libMap: loadLocalLibs(),
	});

	const { all, errorCount } = summarizeDiagnostics(diagnostics);
	expect(errorCount).toBeGreaterThan(0);
	// TS2304: "Cannot find name 'Sand'."
	expect(all.some((d) => d.code === 2304 && d.message.includes("Sand"))).toBe(
		true,
	);
});

test("injected declarations make host globals typecheck cleanly", async () => {
	const fs = new MemoryUnionFs({ "/src/index.ts": GOOD_SOURCE });

	const { diagnostics } = await runTypecheck({
		fs,
		mode: "run",
		compilerOptions: { strict: true },
		libMap: loadLocalLibs(),
		globalDeclarations: sandDeclarations(fs),
	});

	expect(summarizeDiagnostics(diagnostics).errorCount).toBe(0);
});

test("host-function docs become JSDoc comments in the declarations", () => {
	const fs = new MemoryUnionFs();
	const dts = generateHostFunctionDts(createSandHostFunctions({ fs }), {
		async: true,
	});

	// The JSDoc block is emitted immediately above the declared function.
	expect(dts).toContain("/**");
	expect(dts).toContain(" * Read a file's contents as UTF-8 text.");
	expect(dts).toContain(" * @param path Absolute path to the file.");
	expect(dts).toMatch(
		/\/\*\*[\s\S]*?Read a file's contents[\s\S]*?\*\/\s*\n\s*function readFile\(/,
	);
});

test("injected declarations enforce host-function signatures", async () => {
	// `readFile` resolves to a string; assigning it to a number must error.
	const badSource = [
		"async function main(): Promise<void> {",
		'\tconst text = await Sand.fs.readFile("/data.txt");',
		"\tconst n: number = text;",
		"\tvoid n;",
		"}",
		"export {};",
		"",
	].join("\n");
	const fs = new MemoryUnionFs({ "/src/index.ts": badSource });

	const { diagnostics } = await runTypecheck({
		fs,
		mode: "run",
		compilerOptions: { strict: true },
		libMap: loadLocalLibs(),
		globalDeclarations: sandDeclarations(fs),
	});

	const { all } = summarizeDiagnostics(diagnostics);
	// TS2322: Type 'string' is not assignable to type 'number'.
	expect(all.some((d) => d.code === 2322)).toBe(true);
});
