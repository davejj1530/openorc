import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { projects, runs, threads } from "@openorc/db";
import { linkUrl, toBase64Url } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import { INSTALLED_PHONES, rawMacHello } from "@openorc/link/test-fixtures/installed-phone";
import { onlineTaskRpcParams, onlineTaskExecutionRpcParams, type AgentEvent } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { RemoteTestClient } from "./test-client.js";
import { linkSocket } from "./ws-socket.js";
import { installedTaskEvents, installedTaskIdFromTool } from "./test-fixtures/installed-task-phone.js";

let core: OpenOrc;
let dataDir: string;
const phones: RemoteTestClient[] = [];
const taskId = "41c0591f-e6ae-4f8b-b3ac-a6b55b99cc32";
beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-task-phone-test-"));
  let secret: string | null = null;
  core = await OpenOrc.create({
    dataDir,
    ephemeral: true,
    transport: { push() {} },
    remoteSecrets: {
      load: async () => secret,
      save: async (value) => {
        secret = value;
      },
    },
    remoteNetwork: { port: 0, machine: { name: () => "QA", lanHosts: () => ["127.0.0.1"], tailnetHosts: async () => [] } },
  });
  await core.remote.attach((request, origin) => core.handle(request, origin));
  await core.remote.configure(true);
});
afterAll(async () => {
  phones.forEach((phone) => phone.close());
  await core.close();
  await rm(dataDir, { recursive: true, force: true });
});

it.each(Object.entries(INSTALLED_PHONES))("keeps the installed %s handshake unchanged with online task RPCs registered", async (_build, installed) => {
  const offer = installed.decodePairingUrl((await core.remote.beginPairing()).url);
  const ws = new WebSocket(linkUrl(offer.routes[0]!, offer.macKey, nodeCrypto));
  await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
  const hello = await rawMacHello({
    socket: linkSocket(ws),
    crypto: nodeCrypto,
    device: nodeCrypto.generateKeyPair(),
    macKey: offer.macKey,
    pair: { offerId: offer.offerId, secret: toBase64Url(offer.secret) },
  });
  expect(installed.parseMacHello(hello)).toMatchObject({ t: "hello", mac: { name: "QA" }, routes: offer.routes });
});

it("delivers task reference JSON through existing live and history events without changing installed readers", async () => {
  const result = await RemoteTestClient.pair((await core.remote.beginPairing()).url);
  if (typeof result === "string") throw new Error(result);
  phones.push(result);
  const project = projects.insert(core.db, { name: "Compatibility", rootPath: dataDir, gitRemote: null, defaultBranch: "main", settings: {} });
  const thread = threads.insert(core.db, { projectId: project.id, title: "Explicit scoped work", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  const run = runs.insert(core.db, { id: "online-task-compat", taskId: null, threadId: thread.id, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  result.interest([run.id]);
  await result.call("projects.list", {});
  const taskRef = { place: "server", spaceId: "org:fixture", projectId: "shared-project", id: taskId };
  const event: AgentEvent = {
    type: "tool.completed",
    runId: run.id,
    ts: 1,
    toolCallId: "task-call",
    name: "mcp__openorc__task_create",
    output: { content: [{ type: "text", text: JSON.stringify({ id: taskId, status: "backlog", taskRef }) }] },
    isError: false,
  };
  core.ledger.push(event);
  core.frames.push(event);
  const streamed = () => result.pushes.flatMap((push) => (push.type === "frame" && push.frame.runId === run.id ? push.frame.events : []));
  await vi.waitFor(() => expect(streamed()).toHaveLength(1));
  const history = await result.call("events.page", { runId: run.id });
  for (const schema of Object.values(installedTaskEvents))
    for (const delivered of [...streamed(), ...history.events]) {
      const parsed = schema.parse(delivered);
      expect(parsed.output).toEqual(event.output);
      expect(installedTaskIdFromTool({ name: parsed.name, output: parsed.output, done: true, isError: parsed.isError })).toBe(taskId);
      expect(schema.safeParse({ ...delivered, type: "task.changed" }).success).toBe(false);
    }
  expect(await result.call("tasks.get", { id: taskId })).toBeNull();
  for (const method of Object.keys({ ...onlineTaskRpcParams, ...onlineTaskExecutionRpcParams })) {
    await expect(result.request(method, { spaceId: taskRef.spaceId, id: taskId })).rejects.toThrow("not available from a phone");
  }
});
