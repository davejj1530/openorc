import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePairingUrl } from "@openorc/link";
import { projects, runs, threads } from "@openorc/db";
import type { AgentEvent, CorePush, RemotePush, Route } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import type { ProtectedSecretStore } from "../services/extraction-credentials.js";
import { RemoteTestClient } from "./test-client.js";

const GITHUB_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12";
const machine = { name: () => "Test Mac", lanHosts: () => ["127.0.0.1"], tailnetHosts: async () => [] };

function memorySecrets(): ProtectedSecretStore {
  let value: string | null = null;
  return {
    load: async () => value,
    save: async (next) => {
      value = next;
    },
  };
}

async function openCore(dataDir: string, pushed: CorePush[] = []) {
  const core = await OpenOrc.create({ dataDir, ephemeral: true, transport: { push: (message) => pushed.push(message) }, remoteSecrets: memorySecrets(), remoteNetwork: { port: 0, machine } });
  await core.remote.attach((request) => core.handle(request));
  await core.remote.configure(true);
  return core;
}

function client(result: RemoteTestClient | string): RemoteTestClient {
  if (typeof result === "string") throw new Error(`refused: ${result}`);
  return result;
}

const frames = (pushes: RemotePush[]) => pushes.flatMap((push) => (push.type === "frame" ? [push.frame] : []));
const eventsOf = (pushes: RemotePush[], runId: string) => frames(pushes).flatMap((frame) => (frame.runId === runId ? frame.events : []));

let dataDir: string;
let core: OpenOrc;
const pushed: CorePush[] = [];
const phones: RemoteTestClient[] = [];
let route: Route;
let macKey: Uint8Array;

async function pairPhone(name = "Test phone"): Promise<RemoteTestClient> {
  const { url } = await core.remote.beginPairing();
  const phone = client(await RemoteTestClient.pair(url, { name }));
  phones.push(phone);
  return phone;
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-remote-"));
  core = await openCore(dataDir, pushed);
  const offer = decodePairingUrl((await core.remote.beginPairing()).url);
  route = offer.routes[0]!;
  macKey = offer.macKey;
});

afterAll(async () => {
  for (const phone of phones) phone.close();
  await core.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("phone access", () => {
  it("pairs a phone with a pairing code and answers its thread list", async () => {
    const project = projects.insert(core.db, { name: "Remote fixture", rootPath: dataDir, gitRemote: null, defaultBranch: "main", settings: {} });
    threads.insert(core.db, { projectId: project.id, title: "Seen from a phone", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const phone = await pairPhone("David's iPhone");
    const list = await phone.call("threads.list", { projectId: project.id });
    expect(list.map((thread) => thread.title)).toEqual(["Seen from a phone"]);
    const status = await core.remote.status();
    expect(status.listener).toMatchObject({ state: "on", routes: [{ kind: "lan", host: "127.0.0.1" }] });
    expect(status.devices).toContainEqual(expect.objectContaining({ id: phone.deviceId, name: "David's iPhone", connected: true }));
    expect(pushed).toContainEqual({ type: "invalidate", keys: ["remote"] });
  });

  it("tells a phone that has no pairing unpaired, and a spent code that it no longer works", async () => {
    expect(await RemoteTestClient.connect({ route, macKey })).toBe("unpaired");
    const { url } = await core.remote.beginPairing();
    phones.push(client(await RemoteTestClient.pair(url)));
    expect(await RemoteTestClient.pair(url)).toBe("offer-invalid");
  });

  it("sends a phone frames only for the runs it asked for, shaped like history", async () => {
    const phone = await pairPhone();
    phone.interest(["run-wanted"]);
    await phone.request("projects.list", {});
    const delta = (runId: string, text: string): AgentEvent => ({ type: "message.delta", runId, ts: Date.now(), messageId: "m", role: "assistant", text });
    core.frames.push(delta("run-wanted", "Here is the token: "));
    core.frames.push(delta("run-wanted", GITHUB_TOKEN));
    core.frames.push(delta("run-other", "not for this phone"));
    core.frames.push({ type: "tool.completed", runId: "run-wanted", ts: Date.now(), toolCallId: "big", name: "Bash", output: "x".repeat(10_000), isError: false });
    await phone.until(() => eventsOf(phone.pushes, "run-wanted").some((event) => event.type === "tool.completed"));
    const events = eventsOf(phone.pushes, "run-wanted");
    expect(frames(phone.pushes).every((frame) => frame.runId === "run-wanted")).toBe(true);
    expect(events.filter((event) => event.type === "message.delta")).toEqual([expect.objectContaining({ text: "Here is the token: [redacted:github-token]" })]);
    expect(JSON.stringify(phone.pushes)).not.toContain(GITHUB_TOKEN);
    const completed = events.find((event) => event.type === "tool.completed");
    expect(completed).toMatchObject({ toolCallId: "big", outputOmitted: true });
    expect(completed && "output" in completed ? completed.output : undefined).toBeUndefined();
  });

  it("answers a transcript page after the frames made before it", async () => {
    const project = projects.insert(core.db, { name: "Ordering", rootPath: path.join(dataDir, "ordering"), gitRemote: null, defaultBranch: "main", settings: {} });
    const thread = threads.insert(core.db, { projectId: project.id, title: "Ordering", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const run = runs.insert(core.db, { id: "run-ordered", taskId: null, threadId: thread.id, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
    const phone = await pairPhone();
    phone.interest([run.id]);
    await phone.request("projects.list", {});
    core.frames.push({ type: "message.delta", runId: run.id, ts: Date.now(), messageId: "m", role: "assistant", text: "before the page" });
    await phone.call("events.page", { runId: run.id, turns: 1 });
    expect(eventsOf(phone.pushes, run.id)).toContainEqual(expect.objectContaining({ text: "before the page" }));
  });

  it("refuses methods off the list, inherited names, host paths and its own remote controls", async () => {
    const phone = await pairPhone();
    await expect(phone.call("slack.status", {})).rejects.toThrow("not available from a phone");
    await expect(phone.request("toString")).rejects.toThrow("not available from a phone");
    await expect(phone.request("__proto__")).rejects.toThrow("not available from a phone");
    await expect(phone.call("remote.status", {})).rejects.toThrow("not available from a phone");
    await expect(phone.call("memory.settings.set", { enabled: false })).rejects.toThrow("not available from a phone");
    await expect(phone.call("threads.start", { projectId: "p", workingDirectory: "/etc", agent: "codex", mode: "act", permissionMode: "trusted", prompt: "hi" })).rejects.toThrow(
      "Choose a folder for this conversation on your Mac.",
    );
    await expect(phone.call("runs.send", { runId: "r", text: "look", attachments: ["/Users/someone/.ssh/id_ed25519"] })).rejects.toThrow("Only images attached from your phone");
    await expect(phone.call("threads.update", { id: "t", patch: { prUrl: "https://example.com" } })).rejects.toThrow("Make this change on your Mac.");
    expect(await phone.call("projects.list", {})).toBeInstanceOf(Array);
  });

  it("serves a stored tool image by its URL, and nothing by a path", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    const { path: saved } = await core.handle({ type: "rpc", id: 1, method: "attachments.save", params: { name: "dot.png", mime: "image/png", dataBase64: png } }).then((reply) => {
      if (reply.type !== "rpc.result") throw new Error(reply.message);
      return reply.result as { path: string };
    });
    const phone = await pairPhone();
    const asset = await phone.asset({ kind: "attachment", name: path.basename(saved) });
    expect(asset.mime).toBe("image/png");
    expect(Buffer.from(asset.bytes).toString("base64")).toBe(png);
    await expect(phone.asset({ kind: "attachment", name: "../openorc.sqlite" })).rejects.toThrow("not available");
    await expect(phone.asset({ kind: "tool-image", url: `file://${saved}` })).rejects.toThrow("not available");
  });

  it("ends a removed phone's session and refuses it afterwards", async () => {
    const phone = await pairPhone();
    await core.handle({ type: "rpc", id: 2, method: "remote.devices.remove", params: { id: phone.deviceId } });
    await phone.until(() => phone.closed);
    expect(phone.closing).toBe("removed");
    expect(await RemoteTestClient.connect({ route, macKey, device: phone.device })).toBe("unpaired");
  });

  it("tells phones the Mac is shutting down before it closes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openorc-remote-close-"));
    const closing = await openCore(directory);
    try {
      const phone = client(await RemoteTestClient.pair((await closing.remote.beginPairing()).url));
      await closing.close();
      await phone.until(() => phone.closed);
      expect(phone.closing).toBe("shutdown");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
