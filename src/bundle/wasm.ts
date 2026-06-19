import type { InitializeOptions } from "esbuild-wasm";
import type { EsbuildAPI } from "./types";

// Keeping for reference
// const DEFAULT_ESBUILD_WASM_URL = "https://unpkg.com/esbuild-wasm@0.27.2/esbuild.wasm";

let esbuild: typeof import("esbuild-wasm") | null = null;
let initPromise: Promise<typeof import("esbuild-wasm")> | null = null;

export function createWasmEsbuild(options: InitializeOptions): EsbuildAPI {
	async function ensureInitialized(): Promise<typeof import("esbuild-wasm")> {
		if (esbuild) return esbuild;

		if (!initPromise) {
			initPromise = (async () => {
				const mod = await import("esbuild-wasm");
				await mod.initialize(options);
				esbuild = mod;
				return mod;
			})().catch((error) => {
				initPromise = null;
				throw error;
			});
		}

		return initPromise;
	}

	return {
		async build(buildOptions) {
			const es = await ensureInitialized();
			return es.build(buildOptions);
		},
		async context(buildOptions) {
			const es = await ensureInitialized();
			return es.context(buildOptions);
		},
	};
}
