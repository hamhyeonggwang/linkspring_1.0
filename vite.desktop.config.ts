import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
export default defineConfig({
  root: "renderer", base: "./", publicDir: "../public", envDir: false,
  plugins: [react(), { name: "desktop-license-inputs", generateBundle() { writeFileSync("desktop-build/renderer-modules.json", JSON.stringify([...this.getModuleIds()])); } }], resolve: { alias: { "@": resolve(import.meta.dirname) } },
  build: { outDir: "../desktop-build/renderer", emptyOutDir: true, sourcemap: false },
});
