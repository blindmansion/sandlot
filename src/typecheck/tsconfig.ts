/**
 * tsconfig.json resolution and parsing.
 *
 * Locates the nearest `tsconfig.json` and converts its `compilerOptions` into
 * the form the TypeScript compiler expects. Kept separate from the command
 * layer so it can be reused and tested independently.
 */

import ts from "typescript";
import type { TypecheckFileSystem } from "./fs";
import { findUp } from "./util";

export interface LoadTsConfigContext {
	cwd: string;
	fs: Pick<TypecheckFileSystem, "readFile" | "exists">;
}

export interface LoadedTsConfig {
	compilerOptions: ts.CompilerOptions;
	configPath: string;
}

/**
 * Find the nearest `tsconfig.json` (searching up from `projectRoot`) and parse
 * its compiler options.
 *
 * @returns The parsed compiler options and the path they came from, or `null`
 *          if no `tsconfig.json` exists in `projectRoot` or any parent.
 * @throws If the config file is malformed or contains invalid compiler options.
 */
export async function loadTsConfig(
	ctx: LoadTsConfigContext,
	projectRoot: string,
): Promise<LoadedTsConfig | null> {
	const configPath = await findUp(ctx, "tsconfig.json", { from: projectRoot });
	if (!configPath) {
		return null;
	}

	const content = await ctx.fs.readFile(configPath);

	const { config: rawConfig, error: parseError } = ts.parseConfigFileTextToJson(
		configPath,
		content,
	);

	if (parseError) {
		const msg = ts.flattenDiagnosticMessageText(parseError.messageText, "\n");
		throw new Error(`Failed to parse ${configPath}: ${msg}`);
	}

	const { options, errors } = ts.convertCompilerOptionsFromJson(
		rawConfig.compilerOptions ?? {},
		projectRoot,
		configPath,
	);

	if (errors.length > 0) {
		const messages = errors.map((e) =>
			ts.flattenDiagnosticMessageText(e.messageText, "\n"),
		);
		throw new Error(
			`Invalid compilerOptions in ${configPath}:\n${messages.join("\n")}`,
		);
	}

	return { compilerOptions: options, configPath };
}
