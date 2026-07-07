import path from "path";

import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: "./client",
  plugins: [tailwindcss()],
  esbuild: {
    jsxImportSource: "@superblocksteam/library",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./client"),
    },
  },
});
