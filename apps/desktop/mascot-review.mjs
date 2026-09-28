import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import typegpu from "unplugin-typegpu/vite";
const root = new URL("./src/renderer", import.meta.url).pathname;
await build({
  configFile: false,
  root,
  base: "./",
  plugins: [react(), tailwind(), typegpu()],
  resolve: { alias: { "@": root + "/src" } },
  logLevel: "warn",
  build: { outDir: "/tmp/openorc-mascot-review-dist", emptyOutDir: true, rollupOptions: { input: root + "/mascot-review.html" } },
});
