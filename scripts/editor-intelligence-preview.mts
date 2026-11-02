/** Disposable real-core editor fixture. Run: node --import tsx scripts/editor-intelligence-preview.mts */
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { ServerResponse } from "node:http";
import { OpenOrc, WorkerIntelligence } from "../packages/core/src/index.ts";
import { settings } from "../packages/db/src/index.ts";
import { commitAll, git } from "../packages/git/src/index.ts";
import { FileScope, RpcRequest, type CorePush } from "../packages/protocol/src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "apps/desktop");
const require = createRequire(path.join(desktop, "package.json"));
const port = Number(process.env["OPENORC_EDITOR_PREVIEW_PORT"] ?? 5189);
const scratch = await mkdtemp(path.join(tmpdir(), "openorc-editor-qa-"));
const folder = path.join(scratch, "project");
await mkdir(folder);
const files = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, types: [] }, include: ["*.ts"] }),
  "math.ts": "/** Return twice the supplied value. */\nexport function double(value: number): number {\n  return value * 2;\n}\n",
  "main.ts":
    'import { double } from "./math";\n\nexport const person = { firstName: "Ada", age: 36 };\nexport const answer = double(2);\n\nexport function greeting() {\n  return person.firstName;\n}\n\nexport const misspelled = dobule(3);\n',
};
await Promise.all(Object.entries(files).map(([name, text]) => writeFile(path.join(folder, name), text)));
await git(folder, ["init", "-q", "-b", "main"]);
await git(folder, ["config", "user.name", "Editor QA"]);
await git(folder, ["config", "user.email", "editor-qa@example.invalid"]);
await commitAll(folder, "Editor fixture");
const esbuild = await import(pathToFileURL(require.resolve("esbuild")).href);
const workerFile = path.join(scratch, "intelligence-worker.mjs");
await esbuild.build({
  entryPoints: [path.join(desktop, "src/core/intelligence-worker.ts")],
  outfile: workerFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  plugins: [
    {
      name: "typescript-runtime",
      setup(build) {
        build.onResolve({ filter: /^typescript$/ }, () => ({ path: pathToFileURL(require.resolve("typescript")).href, external: true }));
      },
    },
  ],
});

const listeners = new Set<ServerResponse>();
const publish = (push: CorePush) => {
  for (const listener of listeners) listener.write(`data: ${JSON.stringify(push)}\n\n`);
};
const core = await OpenOrc.create({ dataDir: path.join(scratch, "profile"), ephemeral: true, transport: { push: publish }, intelligence: new WorkerIntelligence(() => new Worker(workerFile)) });
settings.set(core.db, "extraction.provider", "off");
const project = await core.projects.import(folder);
const ui = path.join(scratch, "ui");
await require(path.join(root, "scripts/build-transcript-fixture.cjs"))(ui, "editor-intelligence-ui.tsx");
const { preview } = await import(pathToFileURL(require.resolve("vite")).href);
const allowed = new Set(["files.read", "files.list", "files.search", "files.find", "files.write", "files.format", "editor.query", "app.settings.get"]);
const server = await preview({
  configFile: false,
  root: desktop,
  build: { outDir: ui },
  plugins: [
    {
      name: "editor-intelligence-preview",
      configurePreviewServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const url = request.url?.split("?")[0];
          if (url === "/events") {
            response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
            response.write(": connected\n\n");
            listeners.add(response);
            request.on("close", () => listeners.delete(response));
            return;
          }
          try {
            if (url === "/fixture") {
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ project, folder, scratch }));
              return;
            }
            if (url === "/disk") {
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ main: await readFile(path.join(folder, "main.ts"), "utf8"), math: await readFile(path.join(folder, "math.ts"), "utf8") }));
              return;
            }
            if (url === "/rpc" && request.method === "POST") {
              if (request.headers.origin && request.headers.origin !== `http://127.0.0.1:${port}`) {
                response.writeHead(403);
                response.end();
                return;
              }
              let body = "";
              for await (const chunk of request) {
                body += String(chunk);
                if (body.length > 16 * 1024 * 1024) throw new Error("Fixture request too large");
              }
              const rpc = RpcRequest.parse(JSON.parse(body));
              if (!allowed.has(rpc.method)) throw new Error("This fixture serves only the editor");
              if (rpc.method !== "app.settings.get") {
                const params = rpc.params;
                const scope = params && typeof params === "object" && "scope" in params ? FileScope.parse(params.scope) : null;
                if (scope?.kind !== "project" || scope.id !== project.id || scope.workingDirectory) throw new Error("This fixture serves only its disposable project");
              }
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify(await core.handle(rpc)));
              return;
            }
            next();
          } catch (error) {
            response.statusCode = 500;
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          }
        });
      },
    },
  ],
  preview: { host: "127.0.0.1", port, strictPort: true },
});
console.log(`Editor QA: http://127.0.0.1:${port}/\nDisposable files and profile: ${scratch}`);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  for (const listener of listeners) listener.end();
  await server.close();
  await core.close();
  await rm(scratch, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
