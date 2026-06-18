import type { EsbuildAPI } from "./types";

export function createNativeEsbuild(): EsbuildAPI {
	let mod: typeof import("esbuild") | null = null;

	return {
		build: async (options) => {
			mod ??= await import("esbuild");
			return mod.build(options);
		},
	};
}
