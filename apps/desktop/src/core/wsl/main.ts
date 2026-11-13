import { createWriteStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { FRAMES_FD } from "../../shared/wsl-frames";
import { newestBrainBundle } from "../brain-bundle";
import { serveCore, type CoreSession } from "../serve";
import { FrameChannel } from "./channel";
import { scriptTerminal } from "./terminal";
import { moveToTrash } from "./trash";

/**
 * The core inside a WSL distribution, for the Windows app: the same core the app otherwise runs in a utility process,
 * here under the distribution's own Node, so agents, Git and every path are Linux's. Main starts it through wsl.exe
 * and the two talk in frames: main's on this process's input, the core's on descriptor 3. Its output is pointed at its
 * error stream before it starts, so nothing it or a program it starts prints can land between two frames.
 */

/** How long main has to write its first line before this process gives up on it. */
const START_WITHIN_MS = 15_000;
/** The exit that says the first line never came, or was not one. */
const NO_START = 64;

const appDir = import.meta.dirname;

/** The runner's source files the build put beside the entry; cloud sandboxes are given them as they are. */
async function runnerFiles(): Promise<{ name: string; content: Buffer }[]> {
  const dir = path.join(appDir, "runner");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".ts"));
  return Promise.all(names.map(async (name) => ({ name, content: await readFile(path.join(dir, name)) })));
}

const cloudRunnerFiles = await runnerFiles();
let session: CoreSession | null = null;

const waiting = setTimeout(() => {
  process.stderr.write("The app sent no start line.\n");
  process.exit(NO_START);
}, START_WITHIN_MS);

const channel = new FrameChannel(process.stdin, createWriteStream("", { fd: FRAMES_FD }), {
  start({ dataDir, fileKey, qa }) {
    clearTimeout(waiting);
    session = serveCore({
      dataDir,
      fileKey,
      post: channel.post,
      workerDir: appDir,
      qa: qa === true,
      exit: (code) => channel.close(() => process.exit(code)),
      options: {
        terminal: scriptTerminal(),
        trash: moveToTrash,
        cloudRunnerFiles,
        // Main copies the brain it carries beside the versions of this core, where the distribution can read it.
        cloudBrainBundle: () => newestBrainBundle(path.resolve(appDir, "..", "..", "brain")),
        // No simulator or emulator runs inside a distribution.
        deviceSystem: null,
      },
    });
  },
  host: (message) => void session?.receive(message),
  window: (port) => session?.attach(port),
  // The app is gone. Closing as on a quit keeps the ledger whole and ends the agents this core started.
  ended() {
    clearTimeout(waiting);
    if (session) void session.shutdown();
    else process.exit(NO_START);
  },
  noise: (line) => process.stderr.write(`[core] not a frame: ${line.slice(0, 200)}\n`),
});
