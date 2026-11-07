/**
 * The runner OpenOrc uploads into a cloud workspace and runs with the VM's own Node.
 *
 *   daemon    keeps agent processes and relays alive between connections
 *   bridge    joins this command's stdin and stdout to the daemon, one connection from the Mac
 *   seed      makes the checkout from a bundle the Mac sent, or from one commit's pack
 *   seed-over moves a base's checkout to a new workspace's commit, keeping what its setup installed
 *   history   says which commits end a checkout's history, or fills it in from a bundle
 *   snapshot  records the working tree and bundles what the Mac lacks
 *   apply     moves the checkout to a commit and files the Mac sent
 */
import { createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startDaemon } from "./daemon.ts";
import { apply, history, seed, seedOver, snapshot } from "./repo.ts";

function parse(args: string[]): Map<string, string[]> {
  const options = new Map<string, string[]>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.replace(/^--/, "") ?? "";
    options.set(name, [...(options.get(name) ?? []), args[i + 1] ?? ""]);
  }
  return options;
}

function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** The daemon may still be starting, so the first connection is retried for a while. */
async function bridge(socketPath: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const socket = await connect(socketPath);
      process.stdin.pipe(socket);
      socket.pipe(process.stdout);
      process.stdin.on("end", () => socket.end());
      socket.on("close", () => process.exit(0));
      return;
    } catch {
      if (Date.now() > deadline) {
        process.stderr.write("The OpenOrc runner is not running.\n");
        process.exit(3);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

const [command = "", ...rest] = process.argv.slice(2);
const options = parse(rest);
const one = (name: string): string => {
  const value = options.get(name)?.[0];
  if (!value) throw new Error(`--${name} is required`);
  return value;
};
const state = path.resolve(one("state"));
// Unix socket paths are short on macOS, so the socket lives in the temp folder under a name derived from the state.
const socketPath = path.join(os.tmpdir(), `openorc-runner-${createHash("sha256").update(state).digest("hex").slice(0, 16)}.sock`);
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (command === "daemon") await startDaemon(state, socketPath);
else if (command === "bridge") await bridge(socketPath);
else if (command === "seed") {
  const [workRef, origin, ref, pack] = ["work-ref", "origin", "ref", "pack"].map((name) => options.get(name)?.[0]);
  const target = { repo: one("repo"), branch: one("branch"), ...(origin ? { origin } : {}) };
  print(seed(pack ? { ...target, pack, commit: one("commit") } : { ...target, bundle: one("bundle"), ...(workRef ? { workRef } : {}), ...(ref ? { ref } : {}) }));
} else if (command === "seed-over") {
  const [bundle, ref, pack, origin] = ["bundle", "ref", "pack", "origin"].map((name) => options.get(name)?.[0]);
  print(seedOver({ repo: one("repo"), branch: one("branch"), commit: one("commit"), ...(bundle && ref ? { bundle, ref } : {}), ...(pack ? { pack } : {}), ...(origin ? { origin } : {}) }));
} else if (command === "history") print(history(one("repo"), options.get("bundle")?.[0]));
else if (command === "snapshot") print(snapshot(one("repo"), state, options.get("known") ?? []));
else if (command === "apply") print(apply(one("repo"), state, { bundle: one("bundle"), ref: one("ref"), expectTree: one("expect-tree") }));
else {
  process.stderr.write(`Unknown runner command: ${command}\n`);
  process.exit(2);
}
