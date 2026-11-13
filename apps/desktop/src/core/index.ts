import { newestBrainBundle } from "./brain-bundle";
import { serveCore } from "./serve";
import { TrashClient } from "./trash";
import { basename, join } from "node:path";
import type { SpawnTerminal } from "@openorc/core";

/**
 * Utility-process entry. Main forks this once and hands it a MessagePort per
 * renderer. Everything interesting lives in @openorc/core, and serve.ts wires
 * it to main; this file is the Electron-specific glue.
 */

const dataDir = process.env["OPENORC_DATA_DIR"];
if (!dataDir) throw new Error("OPENORC_DATA_DIR is not set");
const fileKey = process.env["OPENORC_FILE_KEY"];
if (!fileKey) throw new Error("OPENORC_FILE_KEY is not set");
// Agents and shells inherit this process's environment. The key signs the file panel's viewer URLs and is dropped so theirs never carries it.
delete process.env["OPENORC_FILE_KEY"];

const post = (message: unknown) => process.parentPort.postMessage(message);
const trash = new TrashClient(post);
// The runner a cloud workspace runs is uploaded as source, so the bundle carries its files as text.
const cloudRunner = import.meta.glob<string>(["../../../../packages/cloud/src/runner/*.ts", "!../../../../packages/cloud/src/runner/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});
/**
 * A terminal for CLIs whose sign-in screens need one, such as `claude setup-token`. Wide, so a token is never wrapped
 * across lines. node-pty carries a native binding, so it loads on first use.
 */
const terminal: SpawnTerminal = async (binary, args, { cwd, env }) => {
  const { spawn } = await import("node-pty");
  const pty = spawn(binary, args, { name: "xterm-256color", cols: 400, rows: 40, cwd, env: env as Record<string, string> });
  return {
    onData: (listener) => void pty.onData(listener),
    onExit: (listener) => void pty.onExit(({ exitCode }) => listener(exitCode)),
    kill: () => pty.kill(),
  };
};

const session = serveCore({
  dataDir,
  fileKey,
  post,
  workerDir: import.meta.dirname,
  qa: __OPENORC_QA__,
  exit: (code) => process.exit(code),
  options: {
    terminal,
    trash: trash.move,
    cloudRunnerFiles: Object.entries(cloudRunner).map(([file, content]) => ({ name: basename(file), content: Buffer.from(content) })),
    // A packaged app carries the brain in its resources; a build run from the repository uses the one built beside it.
    cloudBrainBundle: () => newestBrainBundle(process.env["OPENORC_BRAIN_DIR"] ?? join(import.meta.dirname, "../../../brain/dist")),
  },
});

process.parentPort.on("message", (e) => {
  if (trash.receive(e.data) || session.receive(e.data)) return;
  const [port, media] = e.ports;
  if (port) {
    session.attach(port);
    port.start();
  }
  if (media && !session.closing) void session.core.then((core) => core.devices.attachMedia(media));
});
