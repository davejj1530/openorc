import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agent37Api, type Agent37Api, type Agent37Instance } from "../agent37.js";
import { startFakeAgent37, type FakeAgent37 } from "../agent37-fake.js";
import { Agent37SandboxProvider } from "../agent37-sandbox.js";
import { runnerFiles } from "../runner-client.js";
import { agent37Home, type Agent37BrainVm } from "./agent37-brain.js";
import { BRAIN_IDLE_MS, BRAIN_PORT, brainLayout } from "./layout.js";
import { BrainMachine, BrainUnavailable, type BrainHome } from "./machine.js";
import { agent37Self } from "./self.js";
import { brainKeyText, newBrainKey, parseLaunch } from "./wire.js";

let base: string;
let fake: FakeAgent37;
let api: Agent37Api;
let home: BrainHome<Agent37BrainVm>;

/**
 * flock without the kernel's lock, which macOS lacks: a folder the first start makes with its pid, a second start finds
 * while that pid lives, and the command's exit removes. A holder that died frees it, as the kernel's lock goes with its
 * process. A held descriptor, as the keeper's own lock, is always free here.
 */
const FLOCK = `#!/bin/sh
code=1
while [ $# -gt 0 ]; do case "$1" in -E) code=$2; shift 2 ;; -n) shift ;; *) break ;; esac; done
lock=$1
shift
case "$lock" in *[!0-9]*) ;; *) exit 0 ;; esac
if ! mkdir "$lock.held" 2>/dev/null; then
  holder=$(cat "$lock.held/pid" 2>/dev/null)
  [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null && exit "$code"
fi
echo $$ > "$lock.held/pid"
"$@"
status=$?
rm -rf "$lock.held"
exit $status
`;

/**
 * setsid, which macOS lacks, through Perl's, noting each keeper's pid where it starts, and the group it makes where the
 * fake Agent37 asks, so its stop, sleep or boot still ends what the process started.
 */
const SETSID = `#!/bin/sh
printf '%s\\n' $$ >> keeper.pids
if [ -n "$AGENT37_FAKE_PIDS" ]; then printf '%s\\n' $$ >> "$AGENT37_FAKE_PIDS"; fi
exec perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die' "$@"
`;

/** A brain that writes down the line it started with and its pid, says it is ready, and runs until it is killed. */
const SERVE = `import { writeFileSync } from "node:fs";
let line = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  line += chunk;
  if (!line.includes("\\n")) return;
  writeFileSync("started", JSON.stringify({ line: line.split("\\n")[0], pid: process.pid }));
  process.stdout.write("openorc-brain ready v-test\\n");
  setInterval(() => undefined, 1000);
});
`;

/** ctl's stand-in: whatever it is asked, the brain is ready while the one that started last runs, and none answers else. */
const CTL = `import { readFileSync } from "node:fs";
let pid = 0;
try {
  pid = JSON.parse(readFileSync(new URL("../../started", import.meta.url), "utf8")).pid;
  process.kill(pid, 0);
} catch {
  process.exit(69);
}
process.stdin.once("data", () => process.stdout.write(JSON.stringify({ ok: true, result: { state: "ready", version: "v-test", pid, since: 1, busy: null } }) + "\\n"));
`;

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "openorc-agent37-brain-"));
  const bin = path.join(base, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "flock"), FLOCK, { mode: 0o755 });
  await writeFile(path.join(bin, "setsid"), SETSID, { mode: 0o755 });
  await mkdir(path.join(base, "instances"));
  fake = await startFakeAgent37(path.join(base, "instances"), { env: () => ({ ...process.env, PATH: `${bin}:/usr/bin:/bin:${path.dirname(process.execPath)}` }) });
  api = agent37Api(fake.key, fake.endpoints);
  home = agent37Home({ service: "agent37", key: fake.key, endpoints: fake.endpoints });
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

/** Ends every keeper a start left in `root`, as a boot would. */
async function killKeepers(root: string): Promise<void> {
  for (const pid of (await readFile(path.join(root, "keeper.pids"), "utf8")).split("\n").filter(Boolean)) {
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {
      // Gone already: a second keeper leaves once it finds the brain running.
    }
  }
}

async function eventually<T>(look: () => Promise<T | null>, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const seen = await look();
    if (seen !== null) return seen;
    if (Date.now() > deadline) throw new Error("It did not happen in time.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The installed brain as provisioning leaves it, with stand-ins for its entry points. */
async function installed(instance: Agent37Instance) {
  const layout = brainLayout(path.join(instance.mount_path, "openorc-brain"));
  await mkdir(layout.app("v-test"), { recursive: true });
  await mkdir(layout.run, { recursive: true });
  await writeFile(path.join(layout.app("v-test"), "brain.mjs"), SERVE);
  await writeFile(path.join(layout.app("v-test"), "ctl.mjs"), CTL);
  await symlink("v-test", layout.current);
  return layout;
}

const started = async (root: string): Promise<{ line: string; pid: number } | null> => {
  const text = await readFile(path.join(root, "started"), "utf8").catch(() => null);
  return text ? (JSON.parse(text) as { line: string; pid: number }) : null;
};

describe("the brain's Agent37 instance", () => {
  it("is made once, as the smallest instance that sleeps on its own, its phone port public", async () => {
    const vm = await home.open({ vcpus: 4, region: "fra1" });
    await home.open({ vcpus: 1 });
    expect(await api.list()).toHaveLength(1);
    expect(vm.instance).toMatchObject({
      template: "agent37-base",
      name: "OpenOrc brain",
      metadata: { openorc: "brain" },
      resources: { cpu: 2, memory: 4, disk: 12 },
      auto_sleep: true,
      idle_timeout_seconds: 300,
      status: "running",
    });
    expect(vm.domain(BRAIN_PORT)).toBe(`https://${vm.instance.id}-${BRAIN_PORT}.agent37.app`);
    expect(vm.domain(3000)).toBeNull();
  });

  it("opens the phone port on a brain found without it", async () => {
    const made = await api.create({ name: "OpenOrc brain", metadata: { openorc: "brain" } });
    expect((await home.open({ vcpus: 1 })).domain(BRAIN_PORT)).toBe(`https://${made.id}-${BRAIN_PORT}.agent37.app`);
    expect((await api.get(made.id))?.public_ports.map((open) => open.port)).toEqual([BRAIN_PORT]);
  });

  it("runs a command with its input, both outputs and its exit code, and a root step through Agent37's exec", async () => {
    const vm = await home.open({ vcpus: 1 });
    const command = await vm.runCommand({ cmd: "sh", args: ["-c", 'IFS= read -r line; echo "got $line"; echo oops >&2; exit 3'], cwd: vm.cwd, detached: true, stdin: true });
    await command.writeStdin("hello\n");
    await command.closeStdin();
    const done = await command.wait();
    expect([done.exitCode, await done.stdout(), await done.stderr()]).toEqual([3, "got hello\n", "oops\n"]);
    const heard: string[] = [];
    for await (const line of command.logs()) heard.push(`${line.stream}:${line.data}`);
    expect(heard.sort()).toEqual(["stderr:oops\n", "stdout:got hello\n"]);
    const root = await vm.runCommand({ cmd: "sh", args: ["-c", "echo apt; exit 0", "brain-apt"], cwd: vm.cwd, sudo: true, detached: true });
    expect((await root.wait()).exitCode).toBe(0);
    expect(fake.execs.at(-1)).toMatchObject({ user: "root", command: expect.stringContaining("'brain-apt'") });
    await expect(root.writeStdin("x\n")).rejects.toThrow("takes no input");
  });

  it("drops the connection without ending a command its caller is done with", async () => {
    const vm = await home.open({ vcpus: 1 });
    const command = await vm.runCommand({ cmd: "sh", args: ["-c", "echo $$; exec sleep 30"], cwd: vm.cwd, detached: true, stdin: true });
    const done = new AbortController();
    const waited = command.wait({ signal: done.signal });
    let pid = 0;
    for await (const line of command.logs({ signal: done.signal })) {
      pid = Number(line.data.trim());
      break;
    }
    done.abort();
    await expect(waited).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(pid)).toBe(true);
  });

  it("moves files through OpenOrc's server in it", async () => {
    const vm = await home.open({ vcpus: 1 });
    const file = path.join(vm.cwd, "openorc-brain", "inbox", "r.thread");
    await vm.writeFiles([{ path: file, content: new Uint8Array(Buffer.from("package")) }]);
    expect(Buffer.from((await vm.readFile(file))!).toString()).toBe("package");
    expect(await vm.readFile(`${file}.missing`)).toBeNull();
  });

  it("says when it was last used without waking it: now while it runs, and asleep, when it fell asleep less its idle time", async () => {
    const vm = await home.open({ vcpus: 1 });
    expect(Math.abs((await home.lastUsed!())! - Date.now())).toBeLessThan(2_000);
    await api.sleep(vm.instance.id);
    const asleep = (await api.get(vm.instance.id))!;
    const execs = fake.execs.length;
    expect(await home.lastUsed!()).toBe(asleep.slept_at! * 1000 - BRAIN_IDLE_MS);
    expect([(await api.get(vm.instance.id))?.status, fake.execs.length]).toEqual(["sleeping", execs]);
  });

  it("is looked at without waking: asleep, it reads as stopped and no brain answers, and it stays asleep", async () => {
    const machine = await BrainMachine.connect({ service: "agent37", key: fake.key, endpoints: fake.endpoints });
    expect(await machine.status()).toEqual({ state: "missing", address: null, expiresAt: null });
    const vm = await home.open({ vcpus: 1 });
    await api.sleep(vm.instance.id);
    const [execs, requests] = [fake.execs.length, fake.requests.length];
    expect(await machine.status()).toEqual({ state: "stopped", address: `${vm.instance.id}-${BRAIN_PORT}.agent37.app`, expiresAt: null });
    await expect(machine.control({ op: "status" })).rejects.toThrow(BrainUnavailable);
    expect((await api.get(vm.instance.id))?.status).toBe("sleeping");
    expect(fake.execs.length).toBe(execs);
    expect(fake.requests.slice(requests).filter((request) => !request.startsWith("GET "))).toEqual([]);
    expect((await home.get(true))?.state).toBe("running");
  });

  it("starts the brain by booting its instance, with its instance and connection on the start line the instance keeps", async () => {
    const machine = await BrainMachine.connect({ service: "agent37", key: fake.key, endpoints: fake.endpoints }, { startMs: 10_000, pollMs: 50 });
    const { instance } = await home.open({ vcpus: 1 });
    const layout = await installed(instance);
    const key = newBrainKey();
    const address = `${instance.id}-${BRAIN_PORT}.agent37.app`;
    expect(await machine.wake({ key, name: "Cloud", threadSize: { cpu: 4, memory: 16 } })).toEqual({ state: "ready", address, version: "v-test" });
    const first = (await started(layout.root))!;
    expect({ ...parseLaunch(first.line), key: brainKeyText(parseLaunch(first.line).key) }).toEqual({
      key: brainKeyText(key),
      name: "Cloud",
      address,
      port: BRAIN_PORT,
      vercel: null,
      agent37: { connection: { key: fake.key, cpu: 4, memory: 16 }, instance: instance.id },
    });
    // The wake is done with the start, and the brain runs on.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(first.pid)).toBe(true);
    expect((await api.exec(instance.id, 'printf %s "$OPENORC_BRAIN_START"')).stdout).toBe(first.line);
    const hook = path.join(instance.mount_path, ".agent37", "hooks", "post-restart.sh");
    expect((await stat(hook)).mode & 0o777).toBe(0o755);

    // Again: the brain runs, ctl says it is ready, and nothing kept changes, nor is the instance booted again.
    const edits = () => fake.requests.filter((request) => request === `PATCH /v1/instances/${instance.id}`).length;
    const boots = () => fake.requests.filter((request) => request === `POST /v1/instances/${instance.id}/restart`).length;
    expect([edits(), boots()]).toEqual([1, 1]);
    expect(await machine.wake({ key, name: "Cloud", threadSize: { cpu: 4, memory: 16 } })).toEqual({ state: "ready", address, version: "v-test" });
    expect([edits(), boots()]).toEqual([1, 1]);
    expect(await machine.control({ op: "status" })).toMatchObject({ state: "ready", version: "v-test" });

    // A boot ends every process, the keeper's too; the hook starts the brain again from the kept line.
    await api.restart(instance.id);
    const again = await eventually(async () => {
      const now = await started(layout.root);
      return now && now.pid !== first.pid ? now : null;
    });
    expect(again.line).toBe(first.line);
    expect(alive(first.pid)).toBe(false);
    await killKeepers(layout.root);
    process.kill(again.pid, "SIGKILL");
  });

  it("keeps the brain through a sleep, which ends what a command started, so a call to its address finds it running", async () => {
    const machine = await BrainMachine.connect({ service: "agent37", key: fake.key, endpoints: fake.endpoints }, { startMs: 10_000, pollMs: 50 });
    const { instance } = await home.open({ vcpus: 1 });
    const layout = await installed(instance);
    expect(await machine.wake({ key: newBrainKey(), name: "Cloud" })).toMatchObject({ state: "ready" });
    const brain = (await started(layout.root))!;
    // A process a command left running, as the exec start of brains before this one did.
    await api.exec(instance.id, "setsid sh -c 'echo $$ > by-exec; exec sleep 600' > /dev/null 2>&1 &");
    const byExec = Number(await eventually(() => readFile(path.join(instance.mount_path, "by-exec"), "utf8").catch(() => null)));
    expect(alive(byExec)).toBe(true);

    await api.sleep(instance.id);
    expect((await api.get(instance.id))?.status).toBe("sleeping");
    await eventually(async () => (alive(byExec) ? null : true));
    expect(alive(brain.pid)).toBe(true);
    // Woken again, as a phone's call wakes it: the brain is there without anything starting it.
    const boots = fake.requests.filter((request) => request.endsWith("/restart")).length;
    expect(await machine.wake({ key: newBrainKey(), name: "Cloud" })).toMatchObject({ state: "ready" });
    expect(fake.requests.filter((request) => request.endsWith("/restart")).length).toBe(boots);
    expect((await started(layout.root))!.pid).toBe(brain.pid);
    await killKeepers(layout.root);
    process.kill(brain.pid, "SIGKILL");
  });

  it("starts the brain again when it stops without choosing to, and says so in the keeper's log", async () => {
    const machine = await BrainMachine.connect({ service: "agent37", key: fake.key, endpoints: fake.endpoints }, { startMs: 10_000, pollMs: 50 });
    const { instance } = await home.open({ vcpus: 1 });
    const layout = await installed(instance);
    expect(await machine.wake({ key: newBrainKey(), name: "Cloud" })).toMatchObject({ state: "ready" });
    const first = (await started(layout.root))!;
    process.kill(first.pid, "SIGKILL");
    const again = await eventually(async () => {
      const now = await started(layout.root);
      return now && now.pid !== first.pid ? now : null;
    });
    expect(again.line).toBe(first.line);
    expect(await readFile(path.join(layout.logs, "keeper.log"), "utf8")).toMatch(/The brain stopped \(exit 137\); starting it again\./);
    await killKeepers(layout.root);
    process.kill(again.pid, "SIGKILL");
  });

  it("writes the hook again when the start changed", async () => {
    const vm = await home.open({ vcpus: 1 });
    const marker = path.join(vm.cwd, "line");
    const command = { cmd: "sh", args: ["-c", 'IFS= read -r line; printf %s "$line" > "$0"', marker] };
    await home.keep!(vm, { ...command, line: "first" });
    await home.keep!((await home.get(false))!, { ...command, line: "first" });
    await home.keep!((await home.get(false))!, { ...command, line: "second" });
    expect(fake.requests.filter((request) => request.startsWith("PATCH"))).toHaveLength(2);
    expect((await api.get(vm.instance.id))?.metadata).toMatchObject({ openorc: "brain", start: expect.stringMatching(/^[0-9a-f]{64}$/) });
    await api.exec(vm.instance.id, `sh ${path.join(vm.cwd, ".agent37", "hooks", "post-restart.sh")}`);
    expect(await eventually(() => readFile(marker, "utf8").catch(() => null))).toBe("second");
  });

  it("counts what the brain and the thread instances it made spent, and removes the brain before them", async () => {
    const brain = (await home.open({ vcpus: 1 })).instance;
    const threads = (host: "mac" | "brain") =>
      new Agent37SandboxProvider({ credentials: async () => ({ key: fake.key, cpu: 2, memory: 4 }), files: runnerFiles(), host, api: (key) => agent37Api(key, fake.endpoints) });
    await threads("brain").open("openorc-brain-thread");
    await threads("mac").open("openorc-mac-thread");
    const other = await api.create({ name: "someone-else" });
    const byName = new Map((await api.list()).map((instance) => [instance.name, instance.id]));
    fake.setUsage(brain.id, { total_micros: 1_000_000, compute_micros: 900_000 });
    fake.setUsage(byName.get("openorc-brain-thread")!, { total_micros: 250_000, compute_micros: 200_000 });
    fake.setUsage(byName.get("openorc-mac-thread")!, { total_micros: 4_000_000, compute_micros: 3_000_000 });
    fake.setUsage(other.id, { total_micros: 8_000_000, compute_micros: 7_000_000 });
    expect(await home.costSince(Date.now() - 86_400_000, Date.now())).toBeCloseTo(1.25);
    const before = fake.requests.length;
    await home.removeAll();
    expect(fake.requests.slice(before).filter((request) => request.startsWith("DELETE"))).toEqual([`DELETE /v1/instances/${brain.id}`, `DELETE /v1/instances/${byName.get("openorc-brain-thread")}`]);
    expect((await api.list()).map((instance) => instance.name).sort()).toEqual(["openorc-mac-thread", "someone-else"]);
  });
});

describe("the brain's own Agent37 instance, from inside it", () => {
  it("keeps itself awake with a command each time, raising its idle timeout once, and sleeps", async () => {
    const { instance } = await home.open({ vcpus: 1 });
    const self = agent37Self({ key: fake.key, cpu: 2, memory: 4 }, instance.id, api);
    const before = fake.execs.length;
    const extended = await self.extend(10 * 60_000);
    await self.extend(5 * 60_000);
    expect(extended).toEqual({ expiresAt: expect.closeTo(Date.now() + 600_000, -3), capped: false });
    expect((await api.get(instance.id))?.idle_timeout_seconds).toBe(600);
    expect(fake.requests.filter((request) => request.startsWith("PATCH"))).toHaveLength(1);
    expect(fake.execs.slice(before).map((exec) => exec.command)).toEqual(["true", "true"]);
    expect([self.keepsProcesses, await self.region()]).toEqual([true, "us"]);
    await self.stop();
    expect((await api.get(instance.id))?.status).toBe("sleeping");
  });
});
