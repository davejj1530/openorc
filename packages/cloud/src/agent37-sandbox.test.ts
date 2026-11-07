import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agent37Api, type Agent37Api, type Agent37Instance } from "./agent37.js";
import { startFakeAgent37, type FakeAgent37 } from "./agent37-fake.js";
import { Agent37SandboxProvider, type Agent37Connection } from "./agent37-sandbox.js";
import { harnessCatalog } from "@openorc/protocol";
import { ensureAgent } from "./agent-install.js";
import { checkSandbox, type CheckProgress } from "./check.js";
import { INSTANCE_SERVER_PORT, InstancePort } from "./instance-port.js";
import { runnerFiles } from "./runner-client.js";
import { SANDBOX_AWAY_MS, type Sandbox } from "./sandbox.js";

let base: string;
let fake: FakeAgent37;
let api: Agent37Api;
let connection: Agent37Connection | null;
let provider: Agent37SandboxProvider;

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "openorc-agent37-sandbox-"));
  const bin = path.join(base, "bin");
  await mkdir(bin);
  // Like agent37-base: Node and git, no agent until something installs one.
  await writeFile(
    path.join(bin, "npm"),
    `#!/bin/sh\n[ "$1 $2" = "install -g" ] && [ "\${3%@*}" = "@anthropic-ai/claude-code" ] || exit 1\nprintf '#!/bin/sh\\necho "%s (Claude Code)"\\n' "\${3##*@}" > "${bin}/claude" && chmod +x "${bin}/claude"\n`,
  );
  await chmod(path.join(bin, "npm"), 0o755);
  await mkdir(path.join(base, "instances"));
  fake = await startFakeAgent37(path.join(base, "instances"), { env: () => ({ ...process.env, PATH: `${bin}:/usr/bin:/bin:${path.dirname(process.execPath)}` }) });
  api = agent37Api(fake.key, fake.endpoints);
  connection = { key: fake.key, cpu: 2, memory: 4 };
  provider = new Agent37SandboxProvider({ credentials: async () => connection, files: runnerFiles(), api: (key) => agent37Api(key, fake.endpoints) });
});

afterEach(async () => {
  await fake.close();
  await rm(base, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function eventually(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("It did not happen in time.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const serverStarts = () => fake.execs.filter((exec) => exec.command.includes("instance-server.ts --port")).length;

describe("opening an Agent37 instance", () => {
  it("makes one named for the sandbox in the size Settings asks for, which sleeps on its own after the away window", async () => {
    connection = { key: fake.key, cpu: 4, memory: 16 };
    const sandbox = await provider.open("openorc-a");
    const [instance] = await api.list();
    expect(instance).toMatchObject({
      name: "openorc-a",
      template: "agent37-base",
      metadata: { openorc: "thread" },
      resources: { cpu: 4, memory: 16, disk: 20 },
      auto_sleep: true,
      idle_timeout_seconds: SANDBOX_AWAY_MS / 1000,
    });
    expect(sandbox.root).toBe(instance!.mount_path);
  });

  it("opens the instance that has the name, and makes only one when the name is opened twice at once", async () => {
    const [first, second] = await Promise.all([provider.open("openorc-a"), provider.open("openorc-a")]);
    const again = await provider.open("openorc-a");
    expect(await api.list()).toHaveLength(1);
    expect(new Set([first.root, second.root, again.root]).size).toBe(1);
  });

  it("starts a stopped instance and refuses a failed one in words", async () => {
    const sandbox = await provider.open("openorc-a");
    const [instance] = await api.list();
    await api.stop(instance!.id);
    await provider.open("openorc-a");
    expect((await api.get(instance!.id))?.status).toBe("running");
    fake.setStatus(instance!.id, "failed", "the disk could not be attached");
    await expect(provider.open("openorc-a")).rejects.toThrow("The Agent37 instance failed: the disk could not be attached. Delete it to start over.");
    expect(sandbox.name).toBe("openorc-a");
  });

  it("makes a VM only for a workspace that needs Docker, and only a VM can start Docker", async () => {
    const plain = await provider.open("openorc-a");
    const vm = await provider.open("openorc-b", { docker: true });
    const made = new Map((await api.list()).map((instance) => [instance.name, instance]));
    expect(made.get("openorc-a")).toMatchObject({ type: "default", template: "agent37-base" });
    expect(made.get("openorc-b")).toMatchObject({ type: "vm", template: "agent37-base", metadata: { openorc: "thread", host: "mac", type: "vm" } });
    expect(plain.startDocker).toBeUndefined();
    expect(vm.startDocker).toEqual(expect.any(Function));
  });

  it("keeps the type an instance was made with when its workspace needs Docker later", async () => {
    await provider.open("openorc-a");
    const again = await provider.open("openorc-a", { docker: true });
    expect((await api.list()).map((instance) => instance.type)).toEqual(["default"]);
    expect(again.startDocker).toBeUndefined();
  });

  it("tells a VM by OpenOrc's mark when Agent37 does not report its type", async () => {
    const unreported = (key: string): Agent37Api => {
      const real = agent37Api(key, fake.endpoints);
      const hide = (instance: Agent37Instance): Agent37Instance => ({ ...instance, type: "default" });
      return {
        ...real,
        create: async (params) => hide(await real.create(params)),
        list: async () => (await real.list()).map(hide),
        get: async (id) => {
          const instance = await real.get(id);
          return instance && hide(instance);
        },
      };
    };
    const unsaid = new Agent37SandboxProvider({ credentials: async () => connection, files: runnerFiles(), api: unreported });
    expect((await unsaid.open("openorc-b", { docker: true })).startDocker).toEqual(expect.any(Function));
    expect((await unsaid.open("openorc-a")).startDocker).toBeUndefined();
  });

  it("asks to connect Agent37 until Settings has a key and one of its sizes, without calling Agent37", async () => {
    const before = fake.execs.length;
    for (const value of [null, { key: "", cpu: 2, memory: 4 }, { key: fake.key, cpu: 2, memory: 8 }] as Agent37Connection[]) {
      connection = value;
      await expect(provider.open("openorc-a")).rejects.toThrow("Connect Agent37 in Settings to run in the cloud.");
    }
    connection = null;
    expect(await provider.list()).toEqual([]);
    connection = { key: fake.key, cpu: 2, memory: 4 };
    expect(await api.list()).toEqual([]);
    expect(fake.execs.length).toBe(before);
  });
});

describe("an Agent37 sandbox", () => {
  it("passes each argument as one word, whatever it holds, in the folder and environment asked for", async () => {
    const sandbox = await provider.open("openorc-a");
    const words = ["a b", "it's", "$HOME", "`whoami`", '"quoted"', "", "back\\slash"];
    const printed = await sandbox.exec("printf", ["%s|", ...words]);
    expect(printed).toEqual({ code: 0, stdout: Buffer.from(words.map((word) => `${word}|`).join("")), stderr: "" });

    const folder = path.posix.join(sandbox.root, "work dir");
    await sandbox.exec("mkdir", ["-p", folder]);
    const where = await sandbox.exec(process.execPath, ["-e", "console.log(JSON.stringify([process.cwd(), process.env.PWD, process.env.WHAT]))"], { cwd: folder, env: { WHAT: "it's $1 'x'" } });
    const [cwd, pwd, what] = JSON.parse(where.stdout.toString("utf8")) as string[];
    expect(await import("node:fs/promises").then((fs) => fs.realpath(folder))).toBe(cwd);
    expect([pwd, what]).toEqual([folder, "it's $1 'x'"]);
  });

  it("answers a failing command's exit code instead of throwing, and runs as root when asked", async () => {
    const sandbox = await provider.open("openorc-a");
    expect(await sandbox.exec("sh", ["-c", "echo partial; echo broke >&2; exit 3"], { sudo: true })).toEqual({ code: 3, stdout: Buffer.from("partial\n"), stderr: "broke\n" });
    expect(fake.execs.at(-1)?.user).toBe("root");
  });

  it("throws rather than answer output Agent37 cut off", async () => {
    const sandbox = await provider.open("openorc-a");
    await expect(sandbox.exec("head", ["-c", "600000", "/dev/zero"])).rejects.toThrow("head printed more than Agent37 returns from one command, so its output was cut off.");
  });

  it("says when its server runs but Agent37's address for the port does not reach it, with Agent37's answer", async () => {
    const quick = new Agent37SandboxProvider({ credentials: async () => connection, files: runnerFiles(), api: (key) => agent37Api(key, fake.endpoints), serverStartMs: 1500 });
    const sandbox = await quick.open("openorc-unrouted");
    const instance = (await api.list()).find((each) => each.name === "openorc-unrouted")!;
    fake.unroute(instance.id);
    await expect(sandbox.readFile("/nothing")).rejects.toThrow("OpenOrc's server runs in the Agent37 instance, but Agent37's address for its port answered 502 container_unreachable.");
  });

  it("launches a command that outlives the call", async () => {
    const sandbox = await provider.open("openorc-a");
    const marker = path.posix.join(sandbox.root, "launched.txt");
    const go = path.posix.join(sandbox.root, "go.txt");
    // It waits on a file the test writes, so a slow call cannot outlast it, and stops if the test removes its folder.
    await sandbox.launch("sh", ["-c", `until [ -e "$1" ]; do [ -d "\${0%/*}" ] || exit; sleep 0.05; done; echo done > "$0"`, marker, go]);
    expect(await sandbox.readFile(marker)).toBeNull();
    await sandbox.writeFile(go, Buffer.from("go"));
    await eventually(async () => (await sandbox.readFile(marker))?.toString("utf8") === "done\n");
  });

  it("streams input in and output out, ends when the command exits, and kills it when closed", async () => {
    const sandbox = await provider.open("openorc-a");
    const stream = await sandbox.stream(process.execPath, ["-e", `process.stdin.on("data", (d) => process.stdout.write("pong " + d)); process.stdin.on("end", () => process.exit(0))`]);
    const output: Buffer[] = [];
    stream.output.on("data", (chunk: Buffer) => output.push(chunk));
    stream.input.write("ping\n");
    stream.input.end();
    await stream.ended;
    expect(Buffer.concat(output).toString("utf8")).toBe("pong ping\n");

    const forever = await sandbox.stream("sh", ["-c", "echo $$; exec sleep 30"]);
    const pid = Number(await new Promise<string>((resolve) => forever.output.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")))));
    forever.close();
    await forever.ended;
    await eventually(async () => !alive(pid));
  });

  it("moves files through its own server, which the first file starts once", async () => {
    const sandbox = await provider.open("openorc-a");
    const content = randomBytes(1024 * 1024);
    const file = path.posix.join(sandbox.root, "deep", "er", "bundle.bin");
    await sandbox.writeFile(file, content);
    expect((await sandbox.readFile(file))?.equals(content)).toBe(true);
    expect(await sandbox.readFile(path.posix.join(sandbox.root, "missing"))).toBeNull();
    expect(serverStarts()).toBe(1);
  });

  it("sends a file too large for one request in pieces, as Agent37's edge refuses a large body, and says so in words", async () => {
    const edge = await startFakeAgent37(path.join(base, "instances"), { bodyLimit: 256 * 1024, env: () => ({ ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` }) });
    try {
      const behind = new Agent37SandboxProvider({ credentials: async () => ({ key: edge.key, cpu: 2, memory: 4 }), files: runnerFiles(), api: (key) => agent37Api(key, edge.endpoints) });
      const sandbox = await behind.open("openorc-big");
      await sandbox.writeFile(path.posix.join(sandbox.root, "small.txt"), Buffer.from("starts the server"));
      const [instance] = await agent37Api(edge.key, edge.endpoints).list();
      const address = agent37Api(edge.key, edge.endpoints).port(instance!.id, INSTANCE_SERVER_PORT);
      const build = (await new InstancePort(address).probe())!.split(" ").at(-1)!;
      const content = randomBytes(600 * 1024);
      const file = path.posix.join(sandbox.root, "inbox", "project.bundle");
      await expect(new InstancePort(address, build).putFile(file, content)).rejects.toThrow("Could not send a file to the cloud instance (413 Payload Too Large).");
      await new InstancePort(address, build, 100 * 1024).putFile(file, content);
      expect((await sandbox.readFile(file))?.equals(content)).toBe(true);
      const inbox = await sandbox.exec("ls", ["-a", path.posix.dirname(file)]);
      expect(inbox.stdout.toString().split("\n").filter(Boolean).sort()).toEqual([".", "..", "project.bundle"]);
    } finally {
      await edge.close();
    }
  });

  it("reaches its server only with the account's key", async () => {
    const sandbox = await provider.open("openorc-a");
    await sandbox.writeFile(path.posix.join(sandbox.root, "x.txt"), Buffer.from("x"));
    const [instance] = await api.list();
    const address = api.port(instance!.id, INSTANCE_SERVER_PORT);
    expect(await new InstancePort(address).probe()).toMatch(/^200 openorc-instance-server [0-9a-f]{12}$/);
    expect(await new InstancePort({ ...address, headers: { "x-agent37-key": "sk_live_wrong" } }).probe()).toBe("401 invalid_api_key");
    await expect(new InstancePort({ ...address, headers: {} }).process({ cmd: "true", args: [] })).rejects.toThrow("Could not reach OpenOrc's server in the cloud instance.");
  });

  it("raises its idle timeout only when asked to stay awake longer, and runs a command to count as activity", async () => {
    const sandbox = await provider.open("openorc-a");
    const [instance] = await api.list();
    const edits = () => api.get(instance!.id).then((current) => current?.idle_timeout_seconds);
    await sandbox.keepAwake();
    expect(await edits()).toBe(SANDBOX_AWAY_MS / 1000);
    expect(fake.execs.at(-1)?.command).toBe("true");
    await sandbox.keepAwake(2 * 3_600_000);
    expect(await edits()).toBe(7200);
    await sandbox.keepAwake(60_000);
    expect(await edits()).toBe(7200);
    await sandbox.keepAwake(3 * 86_400_000);
    expect(await edits()).toBe(86_400);
  });

  it("stops its processes and keeps its files; the next call and the next open start it again", async () => {
    const sandbox = await provider.open("openorc-a");
    const [instance] = await api.list();
    const file = path.posix.join(sandbox.root, "kept.txt");
    await sandbox.writeFile(file, Buffer.from("kept"));
    const pid = Number((await sandbox.exec("sh", ["-c", "nohup sleep 30 >/dev/null 2>&1 & echo $!"])).stdout);
    await sandbox.stop();
    expect((await api.get(instance!.id))?.status).toBe("stopped");
    expect(alive(pid)).toBe(false);

    expect((await sandbox.readFile(file))?.toString("utf8")).toBe("kept");
    expect((await api.get(instance!.id))?.status).toBe("running");
    expect(serverStarts()).toBe(2);

    await sandbox.stop();
    const reopened = await provider.open("openorc-a");
    expect((await reopened.exec("cat", [file])).stdout.toString("utf8")).toBe("kept");
  });
});

describe("listing and removing Agent37 instances", () => {
  it("lists only OpenOrc's thread instances, with state, size, and time awake and cost from usage", async () => {
    await provider.open("openorc-a");
    const [mine] = await api.list();
    await api.create({ name: "someone-else" });
    await api.create({ name: "openorc-not-a-thread" });
    fake.setUsage(mine!.id, { total_micros: 1_500_000, compute_micros: 1_000_000 });
    const listed = await provider.list();
    // $1 of compute at $4.40 per 730 hours for 2 CPUs and 4 GB is 165.9 hours.
    expect(listed).toEqual([
      { name: "openorc-a", state: "running", createdAt: mine!.created * 1000, awakeSince: null, awakeMs: expect.closeTo((730 / 4.4) * 3_600_000, -1), vcpus: 2, memoryMb: 4096, costUsd: 1.5 },
    ]);
    await api.sleep(mine!.id);
    fake.setUsage(mine!.id, { total_micros: 0, compute_micros: 0 });
    expect(await provider.list()).toMatchObject([{ state: "stopped", awakeMs: 0, costUsd: 0 }]);
  });

  it("reads a VM's time awake at the 2.5 times rate its compute bills at", async () => {
    await provider.open("openorc-vm", { docker: true });
    const [vm] = await api.list();
    fake.setUsage(vm!.id, { total_micros: 1_000_000, compute_micros: 1_000_000 });
    expect(await provider.list()).toMatchObject([{ name: "openorc-vm", awakeMs: expect.closeTo((730 / (4.4 * 2.5)) * 3_600_000, -1) }]);
  });

  it("keeps the Mac's thread instances and its cloud brain's apart: each host opens, lists and removes only its own", async () => {
    const brain = new Agent37SandboxProvider({ credentials: async () => connection, files: runnerFiles(), host: "brain", api: (key) => agent37Api(key, fake.endpoints) });
    await provider.open("openorc-a");
    await brain.open("openorc-a");
    await api.create({ name: "openorc-from-before", metadata: { openorc: "thread" } });
    expect((await api.list()).map((instance) => instance.metadata?.host ?? null).sort()).toEqual(["brain", "mac", null]);
    expect((await provider.list()).map((listed) => listed.name).sort()).toEqual(["openorc-a", "openorc-from-before"]);
    expect((await brain.list()).map((listed) => listed.name)).toEqual(["openorc-a"]);
    await brain.remove("openorc-a");
    expect((await provider.list()).map((listed) => listed.name).sort()).toEqual(["openorc-a", "openorc-from-before"]);
    expect(await brain.list()).toEqual([]);
  });

  it("deletes an instance by name with its files, and is done when it is already gone", async () => {
    const sandbox = await provider.open("openorc-a");
    await provider.remove("openorc-a");
    expect(await provider.list()).toEqual([]);
    expect(await readdir(path.join(base, "instances"))).toEqual([]);
    await provider.remove("openorc-a");
    expect(sandbox.name).toBe("openorc-a");
  });
});

it("passes every step of the cloud check end to end, installing Claude Code the base template lacks, and deletes its instance", async () => {
  const progress: CheckProgress[] = [];
  const agent = (sandbox: Sandbox) =>
    ensureAgent(sandbox, harnessCatalog.claude.cli, { name: "Claude Code", mayInstall: true, version: "2.1.316", read: (output) => /\d+\.\d+\.\d+/.exec(output)?.[0] ?? null });
  const passed = await checkSandbox(provider, { files: runnerFiles(), node: process.execPath, agent, report: (entry) => progress.push(entry) });
  expect(progress.filter((entry) => entry.state === "failed")).toEqual([]);
  expect(passed).toBe(true);
  expect(progress.filter((entry) => entry.state === "done").map((entry) => entry.step)).toEqual(["sandbox", "tools", "runner", "relay", "sync", "remove"]);
  expect(progress.find((entry) => entry.step === "signins" && entry.state === "skipped")?.detail).toBe("This service keeps each agent's sign-in in its sandbox.");
  expect(progress.find((entry) => entry.step === "tools" && entry.state === "done")?.detail).toMatch(/^Node \d+\.\d+\.\d+ · Git \S+ · Claude Code 2\.1\.316$/);
  expect(await api.list()).toEqual([]);
}, 60_000);

it("waits on a call to a sleeping instance while it restores, as Agent37 holds it, after it fell asleep with nothing reaching it", async () => {
  await mkdir(path.join(base, "slow"));
  const env = () => ({ ...process.env, PATH: `${path.join(base, "bin")}:/usr/bin:/bin:${path.dirname(process.execPath)}` });
  const slow = await startFakeAgent37(path.join(base, "slow"), { env, wakeMs: 600, idleMs: 300 });
  try {
    const slowApi = agent37Api(slow.key, slow.endpoints);
    const sandboxes = new Agent37SandboxProvider({ credentials: async () => ({ key: slow.key, cpu: 2, memory: 4 }), files: runnerFiles(), api: (key) => agent37Api(key, slow.endpoints) });
    const sandbox = await sandboxes.open("openorc-slow");
    const file = path.posix.join(sandbox.root, "kept.txt");
    await sandbox.writeFile(file, Buffer.from("kept"));
    const id = (await slowApi.list())[0]!.id;
    await eventually(async () => (await slowApi.get(id))?.status === "sleeping");
    expect((await slowApi.get(id))?.slept_at).toBeGreaterThan(0);
    const asked = Date.now();
    expect((await sandbox.readFile(file))?.toString("utf8")).toBe("kept");
    expect(Date.now() - asked).toBeGreaterThanOrEqual(550);
    expect((await slowApi.get(id))?.status).toBe("running");
  } finally {
    await slow.close();
  }
}, 30_000);
