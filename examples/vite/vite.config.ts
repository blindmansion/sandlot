import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Add COOP/COEP headers for SharedArrayBuffer support (recommended for esbuild-wasm)
    {
      name: "cross-origin-isolation",
      configureServer: (server) => {
        server.middlewares.use((_req, res, next) => {
          res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
          res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
          next();
        });
      },
    },
  ],
  resolve: {
    alias: {
      // Resolve to source files in dev for HMR and to preserve @vite-ignore comments
      "sandlot/browser": path.resolve(
        __dirname,
        "../../packages/sandlot/src/browser/index.ts"
      ),
      sandlot: path.resolve(__dirname, "../../packages/sandlot/src/index.ts"),
    },
  },
});
