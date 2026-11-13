/** A browser preview of the real desktop components with synthetic data. */
const path = require("node:path");
const desktop = path.resolve(__dirname, "../apps/desktop");
const root = path.resolve(__dirname, "..");
const port = Number(process.env.OPENORC_PREVIEW_PORT ?? 5177);
let fixture = "website-product-ui.tsx";
if (process.env.OPENORC_PREVIEW_VIEW === "onboarding") fixture = "onboarding-ui.tsx";
else if (process.env.OPENORC_PREVIEW_VIEW === "files") fixture = "file-explorer-ui.tsx";

async function main() {
  const { createServer } = await import(require.resolve("vite", { paths: [desktop] }));
  const { default: react } = await import(require.resolve("@vitejs/plugin-react", { paths: [desktop] }));
  const { default: tailwind } = await import(require.resolve("@tailwindcss/vite", { paths: [desktop] }));
  const typegpuModule = (await import(require.resolve("unplugin-typegpu/vite", { paths: [desktop] }))).default;
  const typegpu = typeof typegpuModule === "function" ? typegpuModule : typegpuModule.default;
  const server = await createServer({
    configFile: false,
    root: desktop,
    define: { __OPENORC_QA__: "false" },
    optimizeDeps: { entries: [path.join(__dirname, "fixtures", fixture)] },
    plugins: [
      react(),
      tailwind(),
      typegpu(),
      {
        name: "openorc-design-preview",
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            const url = request.url ?? "/";
            const appearancePreview = url.split("?")[0] === "/appearance-preview.html";
            if (url.split("?")[0] !== "/" && !appearancePreview) return next();
            const entry = appearancePreview ? path.join(desktop, "src/renderer/src/appearance-preview.tsx") : path.join(__dirname, "fixtures", fixture);
            try {
              const html = await server.transformIndexHtml(
                url,
                `<!doctype html>
                <html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
                <title>OpenOrc · Design study</title><link rel="stylesheet" href="/src/renderer/src/app.css"></head>
                <body${appearancePreview ? " inert" : ""}><div id="root" style="height:100vh"></div>
                <script type="module" src="/@fs/${entry}"></script></body></html>`,
              );
              response.setHeader("Content-Type", "text/html");
              response.end(html);
            } catch (error) {
              next(error);
            }
          });
        },
      },
    ],
    resolve: {
      alias: { "@": path.join(desktop, "src/renderer/src"), ...Object.fromEntries(["react", "react-dom", "@tanstack/react-query"].map((name) => [name, path.join(desktop, "node_modules", name)])) },
    },
    server: { host: "127.0.0.1", port, strictPort: true, fs: { allow: [root] } },
  });
  await server.listen();
  console.log(`OpenOrc design preview: http://127.0.0.1:${port}/?design=1&theme=light\nSynthetic data; no live projects or providers are connected.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
