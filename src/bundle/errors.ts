import type * as esbuild from "esbuild-wasm";

interface EsbuildFailure extends Error {
	errors?: esbuild.Message[];
}

export function formatBundleError(error: unknown): string {
	if (typeof error === "object" && error !== null && "errors" in error) {
		const messages = (error as EsbuildFailure).errors ?? [];
		const texts = messages
			.map((message) => message.text.trim())
			.filter((text) => text.length > 0);

		if (texts.length > 0) {
			return texts.join("\n");
		}
	}

	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}
