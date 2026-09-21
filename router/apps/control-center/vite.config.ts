import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: appRoot,
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
