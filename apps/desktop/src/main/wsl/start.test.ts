import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Distro, DistroResult } from "./distro";
import { WSL_NODE } from "./runtime";
import { startWslCore, type WslPlace } from "./start";

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The folder an app carries its core for WSL in. */
function carried(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openorc-wsl-start-"));
  temporary.push(dir);
  writeFileSync(path.join(dir, "wsl-core-abc123.tgz"), "an archive");
  return dir;
}

/** A distribution with everything installed, which says so only when the test lets it. */
function installed() {
  const spawned: string[][] = [];
  let asked!: () => void;
  let answer!: () => void;
  const probing = new Promise<void>((resolve) => (asked = resolve));
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const ok = (stdout = ""): DistroResult => ({ code: 0, stdout: Buffer.from(stdout), stderr: "" });
  const has = ["home=/home/me", "machine=x86_64", "glibc=glibc 2.39", "tar=/usr/bin/tar", `node=v${WSL_NODE.version}`, "core=yes", "brain="].map((line) => `@@openorc@@${line}`).join("\n");
  const distro: Distro = {
    name: "Ubuntu",
    spawn: (argv) => {
      spawned.push([...argv]);
      return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as ReturnType<Distro["spawn"]>;
    },
    run: async (argv) => {
      if (!argv.includes("probe")) return ok();
      asked();
      await answered;
      return ok(has);
    },
    toHost: (inside) => inside,
    toInside: (host) => host,
    terminal: (cwd) => ({ file: "sh", args: [], cwd }),
  };
  return { distro, spawned, probing, answer };
}

function start(distro: Distro) {
  const places: WslPlace[] = [];
  const core = startWslCore({
    distro,
    coreDir: carried(),
    brainDir: null,
    fileKey: "key",
    qa: false,
    fetchNode: async () => Buffer.alloc(0),
    profile: () => "0123456789abcdef",
    placed: (place) => places.push(place),
    log: () => undefined,
  });
  return { core, places };
}

describe("starting the core in a distribution", () => {
  it("says where its home and this app data folder's profile are, then starts it there", async () => {
    const { distro, spawned, answer } = installed();
    const { core, places } = start(distro);
    answer();
    await vi.waitFor(() => expect(spawned).toEqual([["/bin/sh", ".openorc-wsl/setup.sh", "start", WSL_NODE.version, "abc123"]]));
    expect(places).toEqual([{ home: "/home/me", dataDir: "/home/me/.openorc-wsl/profiles/0123456789abcdef/data" }]);
    expect(core.starting).toBe(false);
    core.kill();
  });

  it("starts nothing, and names no profile, once it was ended while the distribution was made ready", async () => {
    const { distro, spawned, probing, answer } = installed();
    const { core, places } = start(distro);
    await probing;
    core.kill();
    answer();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawned).toEqual([]);
    expect(places).toEqual([]);
  });
});
