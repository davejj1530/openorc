import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent37Error, agent37Api, agent37Cost, agent37Error, agent37Hourly, type Agent37Api } from "./agent37.js";
import { startFakeAgent37, type FakeAgent37 } from "./agent37-fake.js";

let dir: string;
let fake: FakeAgent37;
let api: Agent37Api;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "openorc-agent37-"));
  fake = await startFakeAgent37(dir);
  api = agent37Api(fake.key, fake.endpoints);
});

afterEach(async () => {
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the Agent37 client", () => {
  it("makes running instances, lists them newest first, reads and edits one, and finds none by an unknown id", async () => {
    const first = await api.create({ name: "openorc-a", metadata: { openorc: "thread" }, resources: { cpu: 4, memory: 8, disk: 20 }, idle_timeout_seconds: 1800 });
    const second = await api.create({ name: "openorc-b" });
    expect(first).toMatchObject({ status: "running", name: "openorc-a", resources: { cpu: 4, memory: 8, disk: 20 }, idle_timeout_seconds: 1800, metadata: { openorc: "thread" } });
    expect(first.id).toMatch(/^[a-z0-9]{10}$/);
    expect((await api.list()).map((instance) => instance.name)).toEqual(["openorc-b", "openorc-a"]);
    expect(await api.get(second.id)).toEqual(second);
    expect((await api.edit(first.id, { idle_timeout_seconds: 7200 })).idle_timeout_seconds).toBe(7200);
    expect((await api.get(first.id))?.idle_timeout_seconds).toBe(7200);
    expect(await api.get("nosuchinst")).toBeNull();
  });

  it("reads the hosting API's nested refusals, in words where a person can act on them", async () => {
    const shape = await api.create({ resources: { cpu: 3, memory: 4, disk: 20 } }).catch((error: unknown) => error);
    expect(shape).toBeInstanceOf(Agent37Error);
    expect(shape).toMatchObject({ status: 400, code: "invalid_request", message: "resources must be one of the listed shapes." });

    const limited = await startFakeAgent37(dir, { instanceLimit: 1 });
    try {
      const small = agent37Api(limited.key, limited.endpoints);
      await small.create({ name: "one" });
      await expect(small.create({ name: "two" })).rejects.toMatchObject({
        status: 409,
        code: "instance_limit_reached",
        message: "Your Agent37 account has as many instances as it may have. Delete one, or add funds to raise the limit.",
      });
    } finally {
      await limited.close();
    }
  });

  it("refuses a wrong key on the hosting API and on exec alike, whose errors come in two shapes", async () => {
    const instance = await api.create({});
    const wrong = agent37Api("sk_live_wrong", fake.endpoints);
    const refusal = { status: 401, code: "unauthorized", message: "Agent37 did not accept this key." };
    await expect(wrong.list()).rejects.toMatchObject(refusal);
    await expect(wrong.exec(instance.id, "true")).rejects.toMatchObject(refusal);
    await expect(api.exec("nosuchinst", "true")).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("reads an error body that is neither shape by its status", () => {
    expect(agent37Error(502, null)).toMatchObject({ status: 502, code: "http_502", message: "Agent37 answered 502 (http_502)." });
    expect(agent37Error(503, { error: { code: "no_capacity", message: "No capacity in eu" } }).message).toBe(
      "Agent37 has no room for an instance of this size right now. Try a smaller size, or again later.",
    );
    expect(agent37Error(400, { error: { code: "invalid_request", message: "name is too long" } }).message).toBe("name is too long");
  });

  it("runs a command with sh -c in the instance's home and answers its exit code and both outputs", async () => {
    const instance = await api.create({});
    const result = await api.exec(instance.id, `echo "$HOME"; echo oops >&2; exit 4`, { root: true, name: "check-1" });
    expect(result).toEqual({ exit_code: 4, stdout: `${instance.mount_path}\n`, stderr: "oops\n", truncated: false });
    expect(fake.execs.at(-1)).toEqual({ id: instance.id, command: `echo "$HOME"; echo oops >&2; exit 4`, user: "root", name: "check-1" });
  });

  it("says when output passed 512 KB and was cut there", async () => {
    const instance = await api.create({});
    const result = await api.exec(instance.id, `head -c 600000 /dev/zero | tr '\\0' a`);
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(512 * 1024);
  });

  it("stops an instance's processes and keeps it down until started; a sleeping one wakes for a command", async () => {
    const instance = await api.create({});
    const pid = Number((await api.exec(instance.id, "nohup sleep 30 >/dev/null 2>&1 & echo $!")).stdout);
    expect(alive(pid)).toBe(true);
    await api.stop(instance.id);
    expect(alive(pid)).toBe(false);
    expect((await api.get(instance.id))?.status).toBe("stopped");
    await expect(api.exec(instance.id, "true")).rejects.toMatchObject({ status: 409, code: "instance_not_running" });
    await api.start(instance.id);
    expect((await api.exec(instance.id, "echo up")).stdout).toBe("up\n");
    await api.sleep(instance.id);
    expect((await api.get(instance.id))?.status).toBe("sleeping");
    expect((await api.exec(instance.id, "echo awake")).stdout).toBe("awake\n");
    expect((await api.get(instance.id))?.status).toBe("running");
  });

  it("waits through a slow start until the instance runs", async () => {
    const slow = await startFakeAgent37(dir, { startMs: 300 });
    try {
      const client = agent37Api(slow.key, slow.endpoints);
      const instance = await client.create({});
      await client.stop(instance.id);
      const started = Date.now();
      await client.start(instance.id);
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      expect((await client.get(instance.id))?.status).toBe("running");
    } finally {
      await slow.close();
    }
  });

  it("deletes an instance with its files, and is done when it is already gone", async () => {
    const instance = await api.create({});
    expect(existsSync(instance.mount_path)).toBe(true);
    await api.remove(instance.id);
    expect(await api.get(instance.id)).toBeNull();
    expect(existsSync(instance.mount_path)).toBe(false);
    await api.remove(instance.id);
  });

  it("reports spending per instance between two days", async () => {
    const instance = await api.create({});
    fake.setUsage(instance.id, { total_micros: 1_500_000, compute_micros: 1_200_000 });
    expect(await api.usage("2026-08-08", "2026-11-05")).toEqual([{ id: instance.id, total_micros: 1_500_000, compute_micros: 1_200_000 }]);
    await expect(api.usage("yesterday", "2026-11-05")).rejects.toMatchObject({ status: 400, code: "invalid_request" });
  });

  it("addresses an instance's port with the key Agent37 asks for there", () => {
    expect(agent37Api("sk_live_x").port("abc123def4", 47_821)).toEqual({ url: "https://abc123def4-47821.agent37.app", headers: { "x-agent37-key": "sk_live_x" } });
  });
});

describe("Agent37 prices", () => {
  it("bills a 2 CPU, 4 GB, 20 GB instance $6.20 for a 730-hour month of running, $1.80 of it for disk", () => {
    const size = { cpu: 2, memory: 4, disk: 20 };
    expect(agent37Cost(size, 730 * 3_600_000)).toBeCloseTo(6.2, 9);
    expect(agent37Hourly(size).disk * 730).toBeCloseTo(1.8, 9);
    expect(agent37Hourly(size).compute * 730).toBeCloseTo(4.4, 9);
  });
});
