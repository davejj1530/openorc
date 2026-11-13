import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { standInDistro, type Distro } from "./distro";
import { ALREADY_RUNNING, ensureRuntime, parseProbe, profileData, SETUP_SCRIPT, unsupported, WslSetupError, type NodeRelease, type Probe, type RuntimeSource } from "./runtime";

// The scripts run in a real /bin/sh with a real tar, against a home made for the test. The installer refuses any
// machine but the one the core is built for, x64 Linux with glibc, so only there is there anything to install into.
const glibc = (process.report.getReport() as unknown as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime;
const installable = process.platform === "linux" && process.arch === "x64" && Boolean(glibc);
// util-linux's flock, which holds the lock of a running core. A distribution without it starts the core unlocked.
const lockable = installable && spawnSync("/bin/sh", ["-c", "command -v flock"]).status === 0;
const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const folder = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openorc-wsl-runtime-"));
  temporary.push(dir);
  return dir;
};

/** A gzipped archive of `files` under `top`, as tar writes one. */
function archive(files: Record<string, string>, top = "."): Buffer {
  const dir = folder();
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, top, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    if (name.startsWith("bin/")) chmodSync(file, 0o755);
  }
  return execFileSync("tar", ["-czf", "-", "-C", dir, top], { maxBuffer: 64 * 1024 * 1024 });
}

/** Stands in for Node's own archive: one folder holding a `node` that says the version it was made for. */
function fakeNode(version: string): { release: NodeRelease; bytes: Buffer } {
  const bytes = archive({ "bin/node": `#!/bin/sh\necho v${version}\n` }, `node-v${version}-linux-x64`);
  return { release: { version, url: `https://example.invalid/node-v${version}.tar.gz`, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes };
}

function fixture(coreVersion = "abc123") {
  const home = folder();
  const distro = standInDistro("Ubuntu", { ...process.env, HOME: home });
  const node = fakeNode("24.0.1");
  const fetched: string[] = [];
  let coreReads = 0;
  const source: RuntimeSource = {
    core: {
      version: coreVersion,
      read: async () => {
        coreReads++;
        return archive({ "manifest.json": "{}", "core.mjs": "// core\n" });
      },
    },
    brain: [],
    fetchNode: async (url) => {
      fetched.push(url);
      return node.bytes;
    },
  };
  return { home, distro, node, source, fetched, coreReads: () => coreReads, root: path.join(home, ".openorc-wsl") };
}

describe.runIf(installable)("installing the core's runtime in a distribution", () => {
  it("installs Node and the core on the first start, and says how to start it", async () => {
    const { distro, source, node, home, root, fetched } = fixture();
    const steps: string[] = [];
    const runtime = await ensureRuntime(distro, source, (text) => steps.push(text), node.release);
    expect(runtime).toEqual({ command: ["/bin/sh", ".openorc-wsl/setup.sh", "start", "24.0.1", "abc123"], home });
    expect(profileData(runtime.home, "0123456789abcdef")).toBe(`${root}/profiles/0123456789abcdef/data`);
    expect(execFileSync(`${root}/node/24.0.1/bin/node`, ["--version"], { encoding: "utf8" }).trim()).toBe("v24.0.1");
    expect(readFileSync(`${root}/app/abc123/core.mjs`, "utf8")).toBe("// core\n");
    expect(readFileSync(`${root}/setup.sh`, "utf8")).toBe(SETUP_SCRIPT);
    expect(fetched).toEqual([node.release.url]);
    expect(steps).toEqual(["Starting Ubuntu…", "Setting up OpenOrc in Ubuntu: downloading Node 24.0.1…", "Setting up OpenOrc in Ubuntu: installing its core…"]);
  });

  it("starts the core with its output on its error stream and its frames where its output was", async () => {
    const { distro, source, node, root } = fixture();
    const runtime = await ensureRuntime(distro, source, undefined, node.release);
    // Stands in for Node: prints on its output, writes a frame on descriptor 3, and echoes what it was started with.
    writeFileSync(`${root}/node/24.0.1/bin/node`, '#!/bin/sh\necho "printed by a tool"\necho "frame for $1" >&3\ncat\n');
    const result = await distro.run(runtime.command, { input: Buffer.from("from main") });
    expect(result.stdout.toString("utf8")).toBe(`frame for ${root}/app/abc123/core.mjs\n`);
    expect(result.stderr).toBe("printed by a tool\nfrom main");
  });

  it("says only plain words on the way into the distribution, whatever the script holds", async () => {
    const { distro, source, node } = fixture();
    const said: string[][] = [];
    const recording: Distro = { ...distro, run: (argv, options) => (said.push([...argv]), distro.run(argv, options)) };
    const brain = [{ name: "brain-1.tgz", read: async () => Buffer.from("brain") }];
    const runtime = await ensureRuntime(recording, { ...source, brain }, undefined, node.release);
    for (const word of [...said.flat(), ...runtime.command]) expect(word).toMatch(/^[A-Za-z0-9._\/-]+$/);
  });

  it("downloads and installs nothing on a later start", async () => {
    const { distro, source, node, fetched, coreReads } = fixture();
    await ensureRuntime(distro, source, undefined, node.release);
    const steps: string[] = [];
    await ensureRuntime(distro, source, (text) => steps.push(text), node.release);
    expect(fetched).toHaveLength(1);
    expect(coreReads()).toBe(1);
    expect(steps).toEqual(["Starting Ubuntu…"]);
  });

  it.runIf(lockable)("removes what an older app left only once its own core starts, and keeps the profiles beside it", async () => {
    const { distro, source, node, root } = fixture("old111");
    await ensureRuntime(distro, source, undefined, node.release);
    const ledger = path.join(profileData(path.dirname(root), "0123456789abcdef"), "ledger.db");
    mkdirSync(path.dirname(ledger), { recursive: true });
    writeFileSync(ledger, "kept");
    // What a setup that was ended mid-unpack left behind, and what one still running is unpacking into.
    const ended = `gone333.partial.${spawnSync("true").pid}`;
    const unpacking = `soon444.partial.${process.pid}`;
    for (const partial of [ended, unpacking]) mkdirSync(path.join(root, "app", partial));
    const runtime = await ensureRuntime(distro, { ...source, core: { ...source.core, version: "new222" } }, undefined, node.release);
    expect(readdirSync(path.join(root, "app")).sort()).toEqual([ended, "new222", "old111", unpacking].sort());
    expect((await distro.run(runtime.command)).code).toBe(0);
    expect(readdirSync(path.join(root, "app")).sort()).toEqual(["new222", unpacking]);
    expect(readdirSync(path.join(root, "node"))).toEqual(["24.0.1"]);
    expect(readFileSync(ledger, "utf8")).toBe("kept");
  });

  it.runIf(lockable)("leaves a running core's files alone when another app installs its own core and is refused", async () => {
    const { distro, source, node, root } = fixture("run111");
    const runtime = await ensureRuntime(distro, source, undefined, node.release);
    writeFileSync(`${root}/node/24.0.1/bin/node`, "#!/bin/sh\necho up >&3\ncat >/dev/null\n");
    const running = distro.spawn(runtime.command);
    await new Promise((resolve) => running.stdout.once("data", resolve));
    const other = await ensureRuntime(distro, { ...source, core: { ...source.core, version: "new222" } }, undefined, node.release);
    expect((await distro.run(other.command)).code).toBe(ALREADY_RUNNING);
    // The running core still loads files from its folder as it goes.
    expect(readFileSync(`${root}/app/run111/core.mjs`, "utf8")).toBe("// core\n");
    const gone = new Promise((resolve) => running.once("close", resolve));
    running.stdin.end();
    await gone;
  });

  it("refuses a Node that is not the one it expects, and leaves nothing installed", async () => {
    const { distro, source, node, root } = fixture();
    const tampered = { ...source, fetchNode: async () => fakeNode("24.0.1-other").bytes };
    await expect(ensureRuntime(distro, tampered, undefined, node.release)).rejects.toThrow("not the one this version of OpenOrc expects");
    expect(existsSync(path.join(root, "node"))).toBe(false);
  });

  it("says a download failed in words, with the reason", async () => {
    const { distro, source, node } = fixture();
    const offline = {
      ...source,
      fetchNode: async (): Promise<Buffer> => {
        throw new Error("net::ERR_INTERNET_DISCONNECTED");
      },
    };
    await expect(ensureRuntime(distro, offline, undefined, node.release)).rejects.toThrow(/could not be downloaded.*ERR_INTERNET_DISCONNECTED/);
  });

  it("copies the cloud brain the app carries, once", async () => {
    const { distro, source, node, root } = fixture();
    let reads = 0;
    const brain = ["brain-1.tgz", "door-abc.mjs"].map((name) => ({
      name,
      read: async () => {
        reads++;
        return Buffer.from(`content of ${name}`);
      },
    }));
    await ensureRuntime(distro, { ...source, brain }, undefined, node.release);
    await ensureRuntime(distro, { ...source, brain }, undefined, node.release);
    expect(readdirSync(path.join(root, "brain")).sort()).toEqual(["brain-1.tgz", "door-abc.mjs"]);
    expect(readFileSync(path.join(root, "brain", "door-abc.mjs"), "utf8")).toBe("content of door-abc.mjs");
    expect(reads).toBe(2);
  });

  it("keeps its folder to the user alone, one an older app made included", async () => {
    const { distro, source, node, root } = fixture();
    await ensureRuntime(distro, source, undefined, node.release);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    chmodSync(root, 0o755);
    await ensureRuntime(distro, source, undefined, node.release);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it.runIf(lockable)("refuses a second core in a distribution while one runs there, and starts one again once it has gone", async () => {
    const { distro, source, node, root } = fixture();
    const runtime = await ensureRuntime(distro, source, undefined, node.release);
    // Stands in for Node: says it is up on descriptor 3, then runs until its input ends, as the core does.
    writeFileSync(`${root}/node/24.0.1/bin/node`, "#!/bin/sh\necho up >&3\ncat >/dev/null\n");
    const running = distro.spawn(runtime.command);
    await new Promise((resolve) => running.stdout.once("data", resolve));
    expect((await distro.run(runtime.command)).code).toBe(ALREADY_RUNNING);
    const gone = new Promise((resolve) => running.once("close", resolve));
    running.stdin.end();
    await gone;
    expect((await distro.run(runtime.command)).code).toBe(0);
  });

  it.runIf(lockable)("keeps the lock and the frames from a program the core starts, so one that outlives the core holds neither", async () => {
    const { distro, source, node, root } = fixture();
    const runtime = await ensureRuntime(distro, source, undefined, node.release);
    // A real Node as the core, as in a distribution: it starts a program that outlives it, names it in a frame, and leaves.
    writeFileSync(`${root}/node/24.0.1/bin/node`, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
    writeFileSync(
      `${root}/app/abc123/core.mjs`,
      [
        'import { spawn } from "node:child_process";',
        'import { writeSync } from "node:fs";',
        'const left = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });',
        "left.unref();",
        "writeSync(3, `${left.pid}\\n`);",
      ].join("\n"),
    );
    const left: number[] = [];
    try {
      // Each run ends for main only once every holder of its frames has gone, so reaching the next line is the proof for those.
      const first = await distro.run(runtime.command);
      left.push(Number(first.stdout.toString("utf8")));
      expect(first.code).toBe(0);
      expect(readdirSync(`/proc/${left[0]}/fd`).sort()).toEqual(["0", "1", "2"]);
      const second = await distro.run(runtime.command);
      left.push(Number(second.stdout.toString("utf8")));
      expect(second.code).toBe(0);
    } finally {
      for (const pid of left) if (pid) process.kill(pid, "SIGKILL");
    }
  });

  it("stops between steps once nobody waits for it, and installs nothing more", async () => {
    const { distro, source, node, root } = fixture();
    const ending = new AbortController();
    const steps: string[] = [];
    // Ended while Node is on its way: the download is the last thing that happens.
    const ended = {
      ...source,
      fetchNode: async (url: string) => {
        ending.abort();
        return source.fetchNode(url);
      },
    };
    await expect(ensureRuntime(distro, ended, (text) => steps.push(text), node.release, ending.signal)).rejects.toThrow(/abort/i);
    expect(steps).toEqual(["Starting Ubuntu…", "Setting up OpenOrc in Ubuntu: downloading Node 24.0.1…"]);
    expect(existsSync(path.join(root, "node"))).toBe(false);
    expect(existsSync(path.join(root, "app"))).toBe(false);
  });

  it("leaves no half-unpacked folder behind when an archive is no archive", async () => {
    const { distro, source, node, root } = fixture();
    const broken = { ...source, core: { version: "abc123", read: async () => Buffer.from("not an archive") } };
    await expect(ensureRuntime(distro, broken, undefined, node.release)).rejects.toThrow("OpenOrc's core could not be installed in Ubuntu");
    expect(existsSync(path.join(root, "app")) ? readdirSync(path.join(root, "app")) : []).toEqual([]);
  });

  it("says so when the distribution does not start", async () => {
    const dead: Distro = { ...standInDistro("Broken"), run: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: "There is no distribution with the supplied name.\n" }) };
    const { source, node } = fixture();
    await expect(ensureRuntime(dead, source, undefined, node.release)).rejects.toThrow(/Broken did not answer.*There is no distribution with the supplied name\./);
    const silent: Distro = { ...dead, run: async () => ({ code: 1, stdout: Buffer.from("Wsl/Service/WSL_E_DISTRO_NOT_FOUND\n"), stderr: "" }) };
    await expect(ensureRuntime(silent, source, undefined, node.release)).rejects.toThrow(/Broken did not answer.*WSL_E_DISTRO_NOT_FOUND/);
  });

  it("refuses a build that carries no core", async () => {
    const { distro, source, node } = fixture("");
    await expect(ensureRuntime(distro, source, undefined, node.release)).rejects.toBeInstanceOf(WslSetupError);
  });
});

describe("what a distribution reports", () => {
  const ready: Probe = { home: "/home/me", machine: "x86_64", glibc: "glibc 2.39", tar: true, node: "", core: false, brain: [] };

  it("reads its values past a login banner", () => {
    const stdout = [
      "Welcome to Ubuntu",
      "@@openorc@@home=/home/me",
      "@@openorc@@machine=x86_64",
      "@@openorc@@glibc=glibc 2.39",
      "@@openorc@@tar=/usr/bin/tar",
      "@@openorc@@node=v24.22.2",
      "@@openorc@@core=yes",
      "@@openorc@@brain=a.tgz b.mjs ",
      "",
    ].join("\n");
    expect(parseProbe(stdout)).toEqual({ ...ready, node: "v24.22.2", core: true, brain: ["a.tgz", "b.mjs"] });
    expect(parseProbe("no markers here")).toBeNull();
  });

  it("accepts a current x64 distribution", () => {
    expect(unsupported(ready, "Ubuntu")).toBeNull();
    expect(unsupported({ ...ready, glibc: "glibc 2.28" }, "Debian")).toBeNull();
  });

  it("names what a distribution lacks", () => {
    expect(unsupported({ ...ready, machine: "aarch64" }, "Ubuntu")).toMatch(/aarch64.*built for x64/);
    expect(unsupported({ ...ready, glibc: "" }, "Alpine")).toMatch(/no glibc/);
    expect(unsupported({ ...ready, glibc: "glibc 2.27" }, "Ubuntu-18.04")).toMatch(/needs glibc 2\.28 or newer/);
    expect(unsupported({ ...ready, tar: false }, "Ubuntu")).toMatch(/no tar/);
  });
});
