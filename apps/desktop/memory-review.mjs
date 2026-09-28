import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
const port = Number(process.env.OPENORC_MEMORY_REVIEW_PORT ?? 5196);
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
  cacheDir: fileURLToPath(new URL(`./node_modules/.vite-memory-review-${port}`, import.meta.url)),
  plugins: [react(), tailwind()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src/renderer/src", import.meta.url)) } },
  server: { host: "127.0.0.1", port, strictPort: true },
});
await server.listen();
console.log(`Memory review (synthetic data): http://127.0.0.1:${port}/memory-review.html`);
