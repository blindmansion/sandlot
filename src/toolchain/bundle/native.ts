import type { EsbuildAPI } from "./types";

export function createNativeEsbuild(): EsbuildAPI {
	let mod: typeof import("esbuild") | null = null;
	const load = async () => {
		mod ??= await import("esbuild");
		return mod;
	};

	return {
		build: async (options) => (await load()).build(options),
		context: async (options) => (await load()).context(options),
	};
}
