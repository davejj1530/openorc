import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { standInDistro, type Distro } from "./distro";
import { ensureRuntime, parseProbe, SETUP_SCRIPT, unsupported, WslSetupError, type NodeRelease, type Probe, type RuntimeSource } from "./runtime";

// The scripts run in a real /bin/sh with a real tar, against a home made for the test.
const posix = process.platform !== "win32";
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

describe.runIf(posix)("installing the core's runtime in a distribution", () => {
  it("installs Node and the core on the first start, and says how to start it", async () => {
    const { distro, source, node, root, fetched } = fixture();
    const steps: string[] = [];
    const runtime = await ensureRuntime(distro, source, (text) => steps.push(text), node.release);
    expect(runtime).toEqual({ command: ["/bin/sh", ".openorc-wsl/setup.sh", "start", "24.0.1", "abc123"], dataDir: `${root}/data` });
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

  it("replaces the core an older app left, and keeps the profile beside it", async () => {
    const { distro, source, node, root } = fixture("old111");
    await ensureRuntime(distro, source, undefined, node.release);
    mkdirSync(path.join(root, "data"));
    writeFileSync(path.join(root, "data", "ledger.db"), "kept");
    await ensureRuntime(distro, { ...source, core: { ...source.core, version: "new222" } }, undefined, node.release);
    expect(readdirSync(path.join(root, "app"))).toEqual(["new222"]);
    expect(readFileSync(path.join(root, "data", "ledger.db"), "utf8")).toBe("kept");
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
