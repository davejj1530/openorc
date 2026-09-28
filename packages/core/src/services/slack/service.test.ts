import { createServer } from "node:net";
import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { AcpAdapter, CodexAdapter, RunHandle } from "@openorc/agents";
import { git } from "@openorc/git";
import { SlackClientConfig, WORKSPACE_ID } from "@openorc/protocol";
import { configureWorkspace } from "../workspace-home.js";
import type { CorePush, RunSpec } from "@openorc/protocol";
import { OpenOrc } from "../../openorc.js";
import { SlackRelay } from "./relay.js";

const fakeSlack = vi.hoisted(() => ({
  sockets: [] as import("node:events").EventEmitter[],
  post: vi.fn(async (_input: unknown) => ({ ok: true, ts: String(Math.random()) })),
  update: vi.fn(async (_input: unknown) => ({ ok: true })),
  replies: vi.fn(
    async (
      _input: unknown,
    ): Promise<{ ok: boolean; messages: { ts: string; user: string; text: string; files?: { id: string; name?: string; mimetype?: string }[] }[]; response_metadata?: { next_cursor: string } }> => ({
      ok: true,
      messages: [],
    }),
  ),
  file: vi.fn(async ({ file }: { file: string }) => ({
    ok: true,
    file: { id: file, name: "image.png", mimetype: "image/png", size: 68, url_private: `https://files.slack.com/files-pri/TTEAM-${file}/image.png` },
  })),
  auth: vi.fn(async () => ({ team_id: "TTEAM", team: "POC", user_id: "UBOT", bot_id: "BBOT" })),
  member: vi.fn(async ({ user }: { user: string }) => ({ ok: true, user: { id: user, team_id: "TTEAM", real_name: "Alice", is_bot: false, deleted: false } })),
}));
vi.mock("@slack/socket-mode", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    SocketModeClient: class extends EventEmitter {
      constructor() {
        super();
        fakeSlack.sockets.push(this);
      }
      async start() {
        this.emit("connected");
      }
      async disconnect() {
        this.emit("disconnected");
      }
    },
  };
});
vi.mock("@slack/web-api", () => ({
  LogLevel: { ERROR: "error" },
  WebClient: class {
    files = { info: fakeSlack.file };
    auth = { test: fakeSlack.auth };
    users = { info: fakeSlack.member };
    conversations = { replies: fakeSlack.replies };
    chat = { postMessage: fakeSlack.post, update: fakeSlack.update };
  },
}));

/** Exercise the installed SDK's wire-envelope dispatch, not an invented app event. */
async function interaction(socket: import("node:events").EventEmitter, payload: unknown, ack: () => Promise<void> = async () => {}) {
  const sdk = await vi.importActual<typeof import("@slack/socket-mode")>("@slack/socket-mode");
  const send = vi.fn(async () => ack());
  Object.assign(socket, { logger: { debug() {}, getLevel: () => "error" }, send });
  const dispatch = Reflect.get(sdk.SocketModeClient.prototype, "onWebSocketMessage");
  await Reflect.apply(dispatch, socket, [JSON.stringify({ type: "interactive", envelope_id: "interaction-envelope", payload }), false]);
  expect(send).toHaveBeenCalledWith("interaction-envelope", undefined);
}

const cores: OpenOrc[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.close()));
  vi.restoreAllMocks();
  fakeSlack.post.mockClear();
  fakeSlack.file.mockClear();
  fakeSlack.update.mockReset();
  fakeSlack.update.mockResolvedValue({ ok: true });
  fakeSlack.replies.mockReset();
  fakeSlack.replies.mockResolvedValue({ ok: true, messages: [] });
  fakeSlack.member.mockReset();
  fakeSlack.member.mockImplementation(async ({ user }) => ({ ok: true, user: { id: user, team_id: "TTEAM", real_name: "Alice", is_bot: false, deleted: false } }));
  fakeSlack.sockets.length = 0;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function machine(name: string) {
  const dir = await mkdtemp(join(tmpdir(), "openorc-slack-"));
  dirs.push(dir);
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "fixture@example.com"]);
  await git(dir, ["config", "user.name", "Fixture"]);
  await writeFile(join(dir, "README.md"), name);
  await git(dir, ["add", "README.md"]);
  await git(dir, ["commit", "-qm", "fixture"]);
  let encryptedStore: string | null = null;
  const pushed: CorePush[] = [];
  const core = await OpenOrc.create({
    dataDir: join(dir, "data"),
    ephemeral: true,
    transport: { push: (event) => pushed.push(event) },
    slackSecrets: {
      load: async () => encryptedStore,
      save: async (value) => {
        encryptedStore = value;
      },
    },
  });
  cores.push(core);
  vi.spyOn(core.memory, "extractor").mockResolvedValue(null);
  vi.spyOn(core.memory, "onRunFinished").mockImplementation(() => {});
  vi.spyOn(core.textGeneration, "settings").mockResolvedValue({ provider: "off", model: null, resolved: null, reason: null });
  vi.spyOn(core.runs, "models").mockResolvedValue([
    { id: "gpt-6-astra", label: "Astra", agent: "codex", isDefault: false, efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "gpt-5.6-luna", label: "Luna", agent: "codex", isDefault: true, efforts: [], defaultEffort: null },
    { id: "opencode/glm-5.3-flash", label: "GLM Flash", agent: "opencode", isDefault: false, efforts: [], defaultEffort: null },
    { id: "openrouter/z-ai/glm-5.3", label: "GLM 5.3", agent: "opencode", isDefault: true, efforts: [], defaultEffort: null },
  ]);
  vi.spyOn(core.system, "info").mockResolvedValue({
    dataDir: dir,
    gh: { installed: false, path: null },
    harnesses: ["codex", "opencode"].map((id) => ({ id: id as "codex" | "opencode", state: "ready", path: id, version: "fixture", revision: 0 })),
  });
  const project = await core.projects.import(dir);
  await configureWorkspace(core.db, project.rootPath);
  return { core, project, pushed };
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
let eventNumber = 0;
const slackMessages = () => [...fakeSlack.post.mock.calls, ...fakeSlack.update.mock.calls];
const body = (id: string, user: string, text = "summarize this repository") => ({
  event_id: id,
  team_id: "TTEAM",
  event: { type: "app_mention", user, channel: "CTEST", ts: `123.${String(++eventNumber).padStart(6, "0")}`, thread_ts: "123.0", text: `<@UBOT> ${text}` },
});
const complete = (handle: RunHandle, text: string, resultText?: string) => {
  handle.emit("event", { type: "message.completed", runId: handle.runId, messageId: "reply", ts: Date.now(), role: "assistant", text });
  handle.emit("event", { type: "turn.completed", runId: handle.runId, turnId: "turn", ts: Date.now(), status: "success", durationMs: 1, ...(resultText ? { resultText } : {}) });
};

async function mcpToolNames(core: OpenOrc, runId: string): Promise<string[]> {
  const response = await fetch((await core.mcpServer()).urlForRun(runId), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const raw = await response.text();
  const data = raw.split("\n").find((line) => line.startsWith("data: "));
  const payload = JSON.parse(data ? data.slice(6) : raw);
  return payload.result.tools.map((tool: { name: string }) => tool.name);
}

function providers() {
  const started: { spec: RunSpec; handle: RunHandle }[] = [];
  const start = (spec: RunSpec) => {
    let finish!: (code: number) => void;
    const done = new Promise<number>((r) => {
      finish = r;
    });
    const handle = new RunHandle(spec.runId, {
      send: async () => {},
      interrupt() {},
      close() {
        finish(0);
      },
      done,
    });
    started.push({ spec, handle });
    setTimeout(
      () => handle.emit("event", { type: "session.started", runId: spec.runId, ts: Date.now(), agent: spec.agent, externalSessionId: `session-${spec.runId}`, model: spec.model ?? "gpt-6-astra" }),
      0,
    );
    return handle;
  };
  vi.spyOn(CodexAdapter.prototype, "start").mockImplementation(start);
  vi.spyOn(AcpAdapter.prototype, "start").mockImplementation(start);
  return started;
}

async function connected() {
  const { core, project } = await machine("Recovery");
  const port = await freePort();
  await core.slack.saveHost({ botToken: "xoxb-fixture", appToken: "xapp-fixture", channelId: "CTEST", port });
  await core.slack.connectHost();
  const device = await core.slack.addDevice("UALICE", "Alice");
  await core.slack.saveClient({ relayUrl: `http://127.0.0.1:${port}`, deviceKey: device.deviceKey, projectId: project.id, agent: "codex", model: "gpt-6-astra", permissionMode: "review" });
  await core.slack.connectClient();
  const send = (id: string, text: string) => fakeSlack.sockets[0]!.emit("app_mention", { body: body(id, "UALICE", text), ack: async () => {} });
  return { core, send };
}

it.each(["allow", "deny"] as const)("connects a personal bot, isolates its owner, handles %s through Socket Mode, and delivers pending work after reconnect", async (decision) => {
  const started = providers();
  const { core } = await machine("Personal");
  const listen = vi.spyOn(SlackRelay.prototype, "listen");
  expect((await core.slack.status()).mode).toBe("direct");
  await core.slack.saveDirect({ botToken: "xoxb-personal-secret", appToken: "xapp-personal-secret", userId: "UALICE", agent: "codex", model: "gpt-6-astra", permissionMode: "review" });
  await core.slack.connectDirect();
  expect(listen).not.toHaveBeenCalled();
  expect((await core.slack.status()).direct).toMatchObject({ connected: true, ownerName: "Alice", workspace: "POC" });
  expect(JSON.stringify(await core.slack.status())).not.toContain("personal-secret");
  const socket = fakeSlack.sockets.at(-1)!;
  socket.emit("disconnected");
  await expect(core.slack.connectDirect()).rejects.toThrow("still reconnecting");
  expect((await core.slack.status()).direct.connected).toBe(false);
  socket.emit("connected");
  socket.emit("app_mention", { body: body("PERSONAL-BOB", "UBOB"), ack: async () => {} });
  expect(fakeSlack.post).not.toHaveBeenCalled();
  socket.emit("app_mention", { body: body("PERSONAL-ALICE", "UALICE"), ack: async () => {} });
  await vi.waitFor(() => expect(started).toHaveLength(1), { timeout: 3000 });
  expect(started[0]!.spec.model).toBe("gpt-6-astra");
  await expect(core.slack.saveDirect({ userId: "UBOB", agent: "codex", permissionMode: "autonomous" })).rejects.toThrow("pending work");
  await expect(core.slack.connectHost()).rejects.toThrow("personal connection");
  await expect(core.slack.connectClient()).rejects.toThrow("personal connection");
  const patch = "*** Update File: palette.ts\n" + "- old color\n+ neutral charcoal 🌙\n".repeat(1400) + "END OF PATCH";
  const approval = core.runs.requestApproval(started[0]!.spec.runId, "personal-approval", "apply_patch", { patch });
  await vi.waitFor(() => expect(fakeSlack.post.mock.calls.some(([v]) => (v as { blocks?: { type: string }[] }).blocks?.some((b) => b.type === "actions"))).toBe(true), { timeout: 3000 });
  const pages = fakeSlack.post.mock.calls
    .map(([v]) => v as { text: string; blocks?: { type: string; text?: { type: string; text: string }; elements?: { action_id?: string }[] }[] })
    .filter((v) => v.text.includes("Permission requested"));
  const sections = pages.flatMap((page) => page.blocks?.filter((block) => block.type === "section" && block.text?.type === "plain_text").map((block) => block.text!.text) ?? []);
  expect(sections.join("")).toContain(JSON.stringify({ patch }, null, 2));
  expect(sections.every((section) => section.length <= 2800)).toBe(true);
  expect(pages.every((page) => page.blocks!.length < 50)).toBe(true);
  expect(pages.slice(0, -1).every((page) => page.blocks!.every((block) => block.type !== "actions"))).toBe(true);
  expect(
    pages
      .at(-1)!
      .blocks!.at(-1)!
      .elements!.map((button) => button.action_id),
  ).toEqual(["openorc_allow", "openorc_deny"]);
  const postIndex = fakeSlack.post.mock.calls.findIndex(([v]) => (v as { blocks?: { type: string }[] }).blocks?.some((b) => b.type === "actions"));
  const posted = fakeSlack.post.mock.calls[postIndex]![0] as { blocks: { elements?: { value: string }[] }[] };
  const message = await fakeSlack.post.mock.results[postIndex]!.value;
  const action = (user: string) => ({
    type: "block_actions",
    team: { id: "TTEAM" },
    user: { id: user },
    container: { channel_id: "CTEST", message_ts: message.ts },
    actions: [{ action_id: `openorc_${decision}`, value: posted.blocks.at(-1)!.elements![0]!.value }],
  });
  await interaction(socket, action("UBOB"));
  expect(core.runs.pending()).toHaveLength(1);
  await interaction(socket, action("UALICE"));
  expect(await approval).toMatchObject({ decision });
  await core.slack.disconnectDirect();
  complete(started[0]!.handle, "Personal answer after reconnect");
  await vi.waitFor(() => expect(core.threads.list()[0]!.activity).toBe("idle"));
  await core.slack.connectDirect();
  await vi.waitFor(async () => expect((await core.slack.status()).direct).toMatchObject({ connected: true, busy: false, error: null }), { timeout: 3000 });
  expect(started).toHaveLength(1);
  expect(slackMessages().filter(([v]) => JSON.stringify(v).includes("Personal answer after reconnect"))).toHaveLength(1);
  expect(listen).not.toHaveBeenCalled();
});

it("rejects a personal owner outside the bot workspace and reports missing membership access without leaking tokens", async () => {
  const { core } = await machine("Invalid owner");
  await core.slack.saveDirect({ botToken: "xoxb-personal-secret", appToken: "xapp-personal-secret", userId: "UALICE", agent: "codex", permissionMode: "review" });
  fakeSlack.member.mockResolvedValueOnce({ ok: true, user: { id: "UALICE", team_id: "TOTHER", real_name: "Alice", is_bot: false, deleted: false } });
  await expect(core.slack.connectDirect()).rejects.toThrow("same workspace");
  expect((await core.slack.status()).direct).toMatchObject({ enabled: false, connected: false });
  fakeSlack.member.mockRejectedValueOnce(new Error("missing_scope xoxb-personal-secret"));
  await expect(core.slack.connectDirect()).rejects.toThrow("users:read");
  expect(JSON.stringify(await core.slack.status())).not.toContain("personal-secret");
  await core.slack.connectDirect();
  expect((await core.slack.status()).direct.error).toBeNull();
});

it("preserves team relay settings and registration when configuring a personal bot", async () => {
  const { core } = await connected();
  const before = await core.slack.status();
  await expect(core.slack.saveDirect({ userId: "UALICE", agent: "codex", permissionMode: "review" })).rejects.toThrow("Disconnect");
  core.slack.disconnectClient();
  await core.slack.disconnectHost();
  await core.slack.saveDirect({ botToken: "xoxb-personal", appToken: "xapp-personal", userId: "UALICE", agent: "codex", permissionMode: "review" });
  await core.slack.connectDirect();
  const after = await core.slack.status();
  expect(after.client.config).toEqual(before.client.config);
  expect(after.devices.map((d) => d.id)).toEqual(before.devices.map((d) => d.id));
  await core.slack.disconnectDirect();
  // A remote relay client can switch back without starting a host on this computer.
  await expect(core.slack.connectClient()).rejects.toThrow();
  expect((await core.slack.status()).mode).toBe("relay");
  await core.slack.connectHost();
  await core.slack.connectClient();
  expect((await core.slack.status()).client.connected).toBe(true);
});

it.each(["**Full answer**\n" + "Details & examples <code> > results.\n".repeat(170)])("delivers a long formatted answer without exceeding Slack's update fallback limit (%#)", async (answer) => {
  const started = providers();
  const { core, send } = await connected();
  fakeSlack.update.mockImplementation(async (input) => {
    const { text } = input as { text: string };
    if (Buffer.byteLength(text, "utf8") > 4000) throw Object.assign(new Error("Slack rejected the update"), { code: "slack_webapi_platform_error", data: { error: "msg_too_long" } });
    return { ok: true };
  });
  send("LONG-REPLY", "Explain this project in detail");
  await vi.waitFor(() => expect(started).toHaveLength(1), { timeout: 3000 });
  started[0]!.handle.emit("event", { type: "message.completed", runId: started[0]!.spec.runId, messageId: "progress", ts: Date.now(), role: "assistant", text: "Reading the project now." });
  await vi.waitFor(() => expect(fakeSlack.post.mock.calls.some(([input]) => JSON.stringify(input).includes("Reading the project now."))).toBe(true), { timeout: 3000 });
  // Escaping expands the fallback too; preserve the full answer in the Markdown block.
  complete(started[0]!.handle, answer);
  await vi.waitFor(async () => expect((await core.slack.status()).client).toMatchObject({ busy: false, connected: true, error: null }), { timeout: 3000 });
  const update = fakeSlack.update.mock.calls.at(-1)![0] as { text: string; blocks: { type: string; text: unknown }[] };
  expect(update.text.length).toBeLessThanOrEqual(4000);
  expect(Buffer.byteLength(update.text, "utf8")).toBeLessThan(4000);
  expect(update.blocks).toContainEqual({ type: "markdown", text: answer });
  expect(started).toHaveLength(1);
});

it("keeps a failed Slack delivery pending without blaming the device key, and retries on reconnect", async () => {
  const started = providers();
  const { core, send } = await connected();
  send("DELIVERY", "Explain this project");
  await vi.waitFor(() => expect(started).toHaveLength(1), { timeout: 3000 });
  started[0]!.handle.emit("event", { type: "message.completed", runId: started[0]!.spec.runId, messageId: "progress", ts: Date.now(), role: "assistant", text: "Reading the project now." });
  await vi.waitFor(() => expect(fakeSlack.post.mock.calls.some(([input]) => JSON.stringify(input).includes("Reading the project now."))).toBe(true), { timeout: 3000 });
  fakeSlack.update.mockRejectedValue(Object.assign(new Error("secret diagnostic xoxb-do-not-expose"), { data: { error: "missing_scope" } }));
  complete(started[0]!.handle, "The completed answer is retained.");
  await vi.waitFor(async () => expect((await core.slack.status()).client.error).toContain("missing_scope"), { timeout: 3000 });
  expect((await core.slack.status()).client).toMatchObject({ connected: true, busy: true });
  await expect(core.slack.connectClient()).rejects.toThrow("missing_scope");
  expect(JSON.stringify(await core.slack.status())).not.toContain("do-not-expose");
  fakeSlack.update.mockResolvedValue({ ok: true });
  await core.slack.connectClient();
  expect((await core.slack.status()).client).toMatchObject({ connected: true, busy: false, error: null });
  expect(started).toHaveLength(1);
  expect(fakeSlack.update.mock.calls.at(-1)![0]).toMatchObject({ text: expect.stringContaining("The completed answer is retained.") });
});

it("runs two users through the real core, keeps follow-ups separate, and replies without leaking tokens", async () => {
  const started = providers();
  const a = await machine("Alice");
  const b = await machine("Bob");
  const port = await freePort();
  await a.core.slack.saveHost({ botToken: "xoxb-fixture-secret", appToken: "xapp-fixture-secret", channelId: "CTEST", port });
  await a.core.slack.connectHost();
  const alice = await a.core.slack.addDevice("UALICE", "Alice");
  const bob = await a.core.slack.addDevice("UBOB", "Bob");
  for (const [machine, device] of [
    [a, alice],
    [b, bob],
  ] as const) {
    await machine.core.slack.saveClient({
      relayUrl: `http://127.0.0.1:${port}`,
      deviceKey: device.deviceKey,
      projectId: machine.project.id,
      agent: "codex",
      model: "gpt-6-astra",
      permissionMode: "review",
    });
    await machine.core.slack.connectClient();
  }
  const socket = fakeSlack.sockets[0]!;
  const ack = vi.fn(async () => {});
  socket.emit("app_mention", { body: body("EA", "UALICE"), ack });
  socket.emit("app_mention", { body: body("EB", "UBOB"), ack });
  socket.emit("app_mention", { body: body("EA", "UALICE"), ack });
  await vi.waitFor(() => expect(started).toHaveLength(2), { timeout: 8000 });
  const runA = started.find((run) => run.spec.cwd === a.project.rootPath)!;
  const runB = started.find((run) => run.spec.cwd === b.project.rootPath)!;
  expect(runA).toBeDefined();
  expect(runB).toBeDefined();
  expect(runA.spec.permissionMode).toBe("review");
  expect(runB.spec.permissionMode).toBe("review");
  expect(ack).toHaveBeenCalledTimes(3);
  const approval = a.core.runs.requestApproval(runA.spec.runId, "slack-approval", "Bash", { command: "echo approval-fixture" + " ".repeat(40000) });
  await vi.waitFor(() => expect(slackMessages().some(([v]) => (v as { text: string }).text.includes("Permission requested"))).toBe(true), { timeout: 8000 });
  expect(a.core.runs.pending().some((p) => p.approvalId === "slack-approval")).toBe(true);
  expect(b.core.runs.pending()).toHaveLength(0);
  const postIndex = fakeSlack.post.mock.calls.findIndex(([value]) => (value as { blocks?: { type: string }[] }).blocks?.some((b) => b.type === "actions"));
  const posted = fakeSlack.post.mock.calls[postIndex]![0] as { blocks: { elements?: { value: string }[] }[] };
  const approvalId = posted.blocks.at(-1)!.elements![0]!.value;
  const message = await fakeSlack.post.mock.results[postIndex]!.value;
  const action = (user: string) => ({
    type: "block_actions",
    team: { id: "TTEAM" },
    user: { id: user },
    container: { channel_id: "CTEST", message_ts: message.ts },
    actions: [{ action_id: "openorc_deny", value: approvalId }],
  });
  await interaction(socket, action("UBOB"), ack);
  expect(a.core.runs.pending()).toHaveLength(1);
  await interaction(socket, action("UALICE"), ack);
  await interaction(socket, action("UALICE"), ack);
  expect(await approval).toMatchObject({ decision: "deny" });
  const status = await a.core.slack.status();
  expect(JSON.stringify(status)).not.toContain("fixture-secret");
  expect(JSON.stringify(status)).not.toContain(alice.deviceKey);
  runA.handle.emit("event", { type: "message.completed", runId: runA.spec.runId, messageId: "commentary", ts: Date.now(), role: "assistant", text: "I will look at the files first." });
  complete(
    runA.handle,
    "Alice result xapp-1234567890-secret\n\n## Overview\n**Readable answer**\n\n| Name | Value |\n| --- | --- |\n| Stack | TypeScript |\n\n```ts\nconst x = 1;\n```",
    "I will look at the files first.\n\nAlice result and accumulated commentary",
  );
  complete(runB.handle, "Bob result");
  await vi.waitFor(
    () => {
      const texts = slackMessages().map(([value]) => (value as { text: string }).text);
      expect(texts.some((t) => t.includes("Alice result [redacted:slack-app-token]"))).toBe(true);
      expect(texts.some((t) => t.includes("Bob result"))).toBe(true);
    },
    { timeout: 8000 },
  );
  const threadA = a.core.threads.list()[0]!.id;
  const formatted = slackMessages()
    .map(([v]) => v as { text: string; blocks?: { type: string; text: unknown }[] })
    .find((v) => v.text.includes("Alice result"))!;
  expect(formatted.blocks).toContainEqual({ type: "markdown", text: expect.stringContaining("## Overview\n**Readable answer**") });
  expect(formatted.text).not.toContain("I will look at the files first");
  const threadB = b.core.threads.list()[0]!.id;
  expect(a.core.threads.get(threadA)?.projectId).toBe(WORKSPACE_ID);
  expect(a.core.threads.list({ projectId: a.project.id })).toHaveLength(0);
  expect(threadA).not.toBe(threadB);
  await vi.waitFor(() => expect(a.core.threads.get(threadA)?.activity).toBe("idle"));
  // Ordinary model questions reach the configured conversation model unchanged.
  socket.emit("message", {
    body: { event_id: "EQUESTION", team_id: "TTEAM", event: { type: "message", user: "UALICE", channel: "CTEST", thread_ts: "123.0", ts: "124.0", text: "what model are you using right now?" } },
    ack,
  });
  await vi.waitFor(() => expect(started).toHaveLength(3), { timeout: 8000 });
  const question = started[2]!;
  expect(question.spec.model).toBe("gpt-6-astra");
  expect(question.spec.prompt).toContain("what model are you using right now?");
  expect(a.core.textGeneration.settings).not.toHaveBeenCalled();
  expect(a.core.runs.models).not.toHaveBeenCalled(); // No classifier or catalog lookup before the conversation.
  await vi.waitFor(async () => expect((await a.core.slack.executionContext(question.spec.runId)).current.model).toBe("gpt-6-astra"));
  expect(a.core.slack.executionAvailable(question.spec.runId)).toBe(true);
  expect(b.core.slack.executionAvailable(question.spec.runId)).toBe(false);
  expect(await mcpToolNames(a.core, question.spec.runId)).toEqual(expect.arrayContaining(["execution_context", "execution_switch"]));
  await expect(b.core.slack.executionContext(question.spec.runId)).rejects.toThrow("active Slack");
  complete(question.handle, "I'm using Astra. Which project would you like me to read?");
  await vi.waitFor(async () => expect((await a.core.slack.status()).client.busy).toBe(false), { timeout: 8000 });

  expect(a.core.slack.executionAvailable(question.spec.runId)).toBe(false);
  expect((await mcpToolNames(a.core, question.spec.runId)).filter((name) => name.startsWith("execution_"))).toEqual([]);

  const unregistered = join(a.project.rootPath, "demo-app");
  await mkdir(unregistered);
  socket.emit("message", {
    body: {
      event_id: "ESWITCH",
      team_id: "TTEAM",
      event: { type: "message", user: "UALICE", channel: "CTEST", thread_ts: "123.0", ts: "125.0", text: "Use GLM via OpenCode to explain demo-app please" },
    },
    ack,
  });
  await vi.waitFor(() => expect(started).toHaveLength(4), { timeout: 8000 });
  const before = started[3]!;
  expect(before.spec.model).toBe("gpt-6-astra"); // The model interprets the request itself.
  expect(before.spec.prompt).toContain("Use GLM via OpenCode to explain demo-app please");
  const context = await a.core.slack.executionContext(before.spec.runId);
  const folder = context.folders.find((f) => f.rootPath === unregistered)!;
  expect(folder).toBeDefined();
  const choice = { agent: "opencode" as const, model: "openrouter/z-ai/glm-5.3", folderId: folder.id, instructions: "Explain the demo-app project for the owner." };
  await expect(a.core.slack.switchExecution(before.spec.runId, { ...choice, model: "not-a-model" })).rejects.toThrow("exact model");
  await expect(a.core.slack.switchExecution(before.spec.runId, { ...choice, folderId: "other-machine" })).rejects.toThrow("folder ID");
  expect(await a.core.slack.switchExecution(before.spec.runId, choice)).toMatchObject({ queued: true, model: choice.model, workingDirectory: unregistered });
  await expect(a.core.slack.switchExecution(before.spec.runId, choice)).rejects.toThrow("already queued");
  expect(started).toHaveLength(4); // Never close a provider while its switch tool is still executing.
  complete(before.handle, "Switch accepted; continuing now.");
  await vi.waitFor(() => expect(started).toHaveLength(5), { timeout: 8000 });
  const after = started[4]!;
  expect(after.spec).toMatchObject({ agent: "opencode", model: choice.model, cwd: unregistered, permissionMode: "review" });
  expect(after.spec.resumeSessionId).toBeUndefined();
  expect(after.spec.prompt).toContain(choice.instructions);
  expect(after.spec.prompt).toContain("Which project would you like me to read?");
  expect(after.spec.systemPromptAppendix).toContain("what model are you using right now?");
  expect(a.core.threads.get(threadA)).toMatchObject({ agent: "opencode", model: choice.model, workingDirectory: unregistered });
  expect(a.core.threads.list()).toHaveLength(1);
  expect(a.core.projects.list()).toHaveLength(1); // Folder discovery doesn't import a project.
  expect(b.core.threads.get(threadB)?.agent).toBe("codex");
  await expect(a.core.slack.switchExecution(before.spec.runId, choice)).rejects.toThrow("active Slack");
  expect(slackMessages().some(([v]) => (v as { text: string }).text.includes("Switch accepted"))).toBe(false);
  complete(after.handle, "demo-app explained by GLM.");
  await vi.waitFor(async () => expect((await a.core.slack.status()).client.busy).toBe(false), { timeout: 8000 });
  expect(slackMessages().some(([v]) => (v as { text: string }).text.includes("demo-app explained by GLM"))).toBe(true);
  expect(
    a.core.threads
      .messages(threadA)
      .filter((m) => m.role === "user")
      .map((m) => m.text),
  ).toEqual(["summarize this repository", "what model are you using right now?", "Use GLM via OpenCode to explain demo-app please"]);

  // The chosen model/folder persist, regardless of a later entrypoint change.
  await configureWorkspace(a.core.db, b.project.rootPath);
  socket.emit("app_mention", { body: body("ERETAINED", "UALICE", "Tell me more"), ack });
  await vi.waitFor(() => expect(started).toHaveLength(6), { timeout: 8000 });
  expect(started[5]!.spec).toMatchObject({ agent: "opencode", model: choice.model, cwd: unregistered });
  // A queued switch is discarded if the current turn is cancelled.
  await a.core.slack.switchExecution(started[5]!.spec.runId, { agent: "codex", model: "gpt-5.6-luna", instructions: "Continue." });
  started[5]!.handle.emit("event", { type: "turn.completed", runId: started[5]!.spec.runId, turnId: "cancelled", ts: Date.now(), status: "cancelled", durationMs: 1 });
  await vi.waitFor(async () => expect((await a.core.slack.status()).client.busy).toBe(false), { timeout: 8000 });
  expect(started).toHaveLength(6);
  await expect(a.core.slack.executionContext(started[5]!.spec.runId)).rejects.toThrow("active Slack");
  // A new channel starts its own conversation with the configured default.
  const other = body("ENEW", "UALICE", "u there?");
  other.event.channel = "COTHER";
  socket.emit("app_mention", { body: other, ack });
  await vi.waitFor(() => expect(started).toHaveLength(7), { timeout: 8000 });
  expect(started[6]!.spec).toMatchObject({ agent: "codex", model: "gpt-6-astra", cwd: b.project.rootPath });
  expect(a.core.threads.list()).toHaveLength(2);
  complete(started[6]!.handle, "Yes, I'm here.");
  await vi.waitFor(async () => expect((await a.core.slack.status()).client.busy).toBe(false), { timeout: 8000 });
  a.core.slack.disconnectClient();
  await a.core.slack.connectClient();
  socket.emit("app_mention", { body: other, ack });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(started).toHaveLength(7);
});

it("does not expose secret RPC parameters even with diagnostic logging enabled", async () => {
  const { core, pushed } = await machine("RPC");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const previous = process.env.OPENORC_RPC_LOG;
  process.env.OPENORC_RPC_LOG = "1";
  try {
    await core.handle({ type: "rpc", id: 91, method: "slack.host.save", params: { botToken: "xoxb-private-fixture", appToken: "xapp-private-fixture", channelId: "CTEST", port: 47831 } });
    expect(pushed.find((p) => p.type === "rpc.result" && p.id === 91)).toBeDefined();
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-fixture");
    expect(JSON.stringify(pushed)).not.toContain("private-fixture");
  } finally {
    if (previous === undefined) delete process.env.OPENORC_RPC_LOG;
    else process.env.OPENORC_RPC_LOG = previous;
  }
});

it("recovers a failed model switch through the default model in the same conversation", async () => {
  const started = providers();
  const { core, send } = await connected();
  send("RECOVER", "Explain demo-app using GLM");
  await vi.waitFor(() => expect(started).toHaveLength(1), { timeout: 3000 });
  await core.slack.switchExecution(started[0]!.spec.runId, { agent: "opencode", model: "opencode/glm-5.3-flash", instructions: "Explain demo-app" });
  complete(started[0]!.handle, "Switching to GLM.");
  await vi.waitFor(() => expect(started).toHaveLength(2));
  const failed = started[1]!;
  const error = "OpenCode cannot run opencode/glm-5.3-flash: you are not signed in to its provider.";
  failed.handle.emit("event", { type: "error", runId: failed.spec.runId, ts: Date.now(), fatal: true, message: error });
  failed.handle.emit("event", { type: "turn.completed", runId: failed.spec.runId, turnId: "failed", ts: Date.now(), status: "error", durationMs: 0 });
  await vi.waitFor(() => expect(started).toHaveLength(3), { timeout: 2000 });
  expect(started[2]!.spec).toMatchObject({ agent: "codex", model: "gpt-6-astra", permissionMode: "review" });
  expect(started[2]!.spec.prompt).toContain(error);
  expect(started[2]!.spec.prompt).toContain("Explain demo-app");
  expect(core.threads.list()).toHaveLength(1);
  complete(started[2]!.handle, "GLM's provider isn't connected. I can help choose an available model.");
  await vi.waitFor(async () => expect((await core.slack.status()).client.busy).toBe(false), { timeout: 3000 });
  send("FIX", "use the openrouter version");
  await vi.waitFor(() => expect(started).toHaveLength(4), { timeout: 3000 });
  expect(started[3]!.spec).toMatchObject({ agent: "codex", model: "gpt-6-astra" });
  expect(started[3]!.spec.prompt).toContain("use the openrouter version");
  await core.slack.switchExecution(started[3]!.spec.runId, { agent: "opencode", model: "openrouter/z-ai/glm-5.3", instructions: "Explain demo-app using the requested OpenRouter provider." });
  complete(started[3]!.handle, "Switching to the OpenRouter version.");
  await vi.waitFor(() => expect(started).toHaveLength(5), { timeout: 3000 });
  expect(started[4]!.spec.model).toBe("openrouter/z-ai/glm-5.3");
  expect(started[4]!.spec.prompt).toContain("use the openrouter version");
  expect(core.threads.list()).toHaveLength(1);
  complete(started[4]!.handle, "demo-app explained with OpenRouter GLM.");
});

it("delivers assistant text to Slack before completion without exposing reasoning", async () => {
  const started = providers();
  const { core, send } = await connected();
  send("PROGRESS", "Read demo-app and explain it");
  await vi.waitFor(() => expect(started).toHaveLength(1), { timeout: 3000 });
  const run = started[0]!;
  run.handle.emit("event", { type: "message.delta", runId: run.spec.runId, ts: Date.now(), messageId: "progress", role: "assistant", text: "I'm reading the README now." });
  await vi.waitFor(() => expect([...fakeSlack.post.mock.calls, ...fakeSlack.update.mock.calls].some(([v]) => (v as { text: string }).text.includes("I'm reading the README now."))).toBe(true), {
    timeout: 2500,
  });
  expect((await core.slack.status()).client.busy).toBe(true);
  const progressCall = fakeSlack.post.mock.calls.findIndex(([v]) => (v as { text: string }).text.includes("I'm reading the README now."));
  const progressTs = (await fakeSlack.post.mock.results[progressCall]!.value).ts;
  run.handle.emit("event", { type: "thinking.delta", runId: run.spec.runId, ts: Date.now(), messageId: "private", text: "PRIVATE-REASONING" });
  run.handle.emit("event", { type: "tool.started", runId: run.spec.runId, ts: Date.now(), toolCallId: "read", name: "read_file", input: { private: "RAW-TOOL-INPUT" }, parentToolCallId: null });
  complete(run.handle, "demo-app is a small web service.");
  await vi.waitFor(async () => expect((await core.slack.status()).client.busy).toBe(false), { timeout: 3000 });
  expect(fakeSlack.update.mock.calls.some(([v]) => (v as { ts: string; text: string }).ts === progressTs && (v as { text: string }).text.includes("demo-app is a small web service."))).toBe(true);
  expect(JSON.stringify(slackMessages())).not.toContain("PRIVATE-REASONING");
  expect(JSON.stringify(slackMessages())).not.toContain("RAW-TOOL-INPUT");
});

it("handles startup exceptions once and leaves an actionable reply if the default also fails", async () => {
  providers();
  const { core, send } = await connected();
  const start = vi.mocked(CodexAdapter.prototype.start).mockImplementation(() => {
    throw new Error("Default provider unavailable");
  });
  send("STARTUP", "hello");
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2), { timeout: 3000 });
  await vi.waitFor(async () => expect((await core.slack.status()).client.busy).toBe(false), { timeout: 3000 });
  expect(slackMessages().some(([v]) => (v as { text: string }).text.includes("Default provider unavailable"))).toBe(true);
  expect(start).toHaveBeenCalledTimes(2);
});

it("reports missing thread history to the model instead of pretending it received all messages", async () => {
  const started = providers();
  const { send } = await connected();
  fakeSlack.replies.mockRejectedValueOnce(new Error("missing_scope"));
  send("HISTORY-FAIL", "what was the opener?");
  await vi.waitFor(() => expect(started).toHaveLength(1), { timeout: 3000 });
  expect(started[0]!.spec.prompt).toContain("Thread history warning:");
  expect(started[0]!.spec.prompt).toContain("Earlier messages may be missing");
  complete(started[0]!.handle, "Slack hasn't provided the opener; please check history access.");
});

it("loads the thread opener and every page before answering a first mention in a reply", async () => {
  const started = providers();
  const { core } = await connected();
  fakeSlack.replies.mockResolvedValueOnce({ ok: true, messages: [{ ts: "100.0", user: "UALICE", text: "Im just testing around" }], response_metadata: { next_cursor: "page2" } });
  fakeSlack.replies.mockResolvedValueOnce({ ok: true, messages: Array.from({ length: 45 }, (_, i) => ({ ts: `${101 + i}.0`, user: "UBOB", text: `Earlier message ${i}` })) });
  fakeSlack.sockets[0]!.emit("app_mention", {
    body: { event_id: "HISTORY", team_id: "TTEAM", event: { type: "app_mention", channel: "CTEST", user: "UALICE", ts: "150.0", thread_ts: "100.0", text: "<@UBOT> can you see this" } },
    ack: async () => {},
  });
  await vi.waitFor(() => expect(started).toHaveLength(1), { timeout: 3000 });
  expect(started[0]!.spec.prompt).toContain("Im just testing around");
  for (let i = 0; i < 45; i++) expect(started[0]!.spec.prompt).toContain(`Earlier message ${i}`);
  expect(fakeSlack.replies).toHaveBeenCalledTimes(2);
  expect(fakeSlack.replies.mock.calls[1]![0]).toMatchObject({ channel: "CTEST", ts: "100.0", cursor: "page2", latest: "150.0" });
  expect(core.threads.messages(core.threads.list()[0]!.id)).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", text: "Im just testing around" })]));
  complete(started[0]!.handle, "Yes, I can see the opener and the replies.");
});

it("switches effort with a model/folder and independently, preserves it for follow-ups, and rejects unsupported levels", async () => {
  const started = providers();
  const { core, send } = await connected();
  send("EFFORT", "Move to demo-app and use Astra on high");
  await vi.waitFor(() => expect(started).toHaveLength(1), { timeout: 3000 });
  const context = await core.slack.executionContext(started[0]!.spec.runId);
  expect(context.models.find((m) => m.id === "gpt-6-astra")).toMatchObject({ efforts: ["low", "medium", "high"], defaultEffort: "medium" });
  const folder = join(context.current.workingDirectory!, "demo-app");
  await mkdir(folder);
  const folderId = (await core.slack.executionContext(started[0]!.spec.runId)).folders.find((f) => f.rootPath === folder)!.id;
  await expect(core.slack.switchExecution(started[0]!.spec.runId, { effort: "ultra", instructions: "Continue" })).rejects.toThrow("effort");
  const result = await core.slack.switchExecution(started[0]!.spec.runId, { agent: "codex", model: "gpt-6-astra", effort: "high", folderId, instructions: "Explain demo-app" });
  expect(result).toMatchObject({ queued: true, effort: "high" });
  complete(started[0]!.handle, "Switching to Astra high in demo-app.");
  await vi.waitFor(() => expect(started).toHaveLength(2));
  expect(started[1]!.spec).toMatchObject({ model: "gpt-6-astra", effort: "high", cwd: folder });
  expect((await core.slack.executionContext(started[1]!.spec.runId)).current).toMatchObject({ effort: "high" });
  expect(core.threads.list()[0]!.effort).toBe("high");
  // A folder-only switch retains effort.
  await core.slack.switchExecution(started[1]!.spec.runId, { folderId: WORKSPACE_ID, instructions: "Continue" });
  complete(started[1]!.handle, "Returning to Workspace.");
  await vi.waitFor(() => expect(started).toHaveLength(3));
  expect(started[2]!.spec.effort).toBe("high");
  await core.slack.switchExecution(started[2]!.spec.runId, { effort: "low", instructions: "Continue with low effort" });
  complete(started[2]!.handle, "Switching to low.");
  await vi.waitFor(() => expect(started).toHaveLength(4));
  expect(started[3]!.spec.effort).toBe("low");
  expect(await core.slack.switchExecution(started[3]!.spec.runId, { effort: "low", instructions: "Continue" })).toMatchObject({ switched: false });
  complete(started[3]!.handle, "Done on low.");
  await vi.waitFor(async () => expect((await core.slack.status()).client.busy).toBe(false), { timeout: 3000 });
  send("EFFORT-FOLLOW", "Tell me more");
  await vi.waitFor(() => expect(started).toHaveLength(5), { timeout: 3000 });
  expect(started[4]!.spec.effort).toBe("low");
  await expect(core.slack.switchExecution(started[4]!.spec.runId, { agent: "opencode", model: "openrouter/z-ai/glm-5.3", effort: "high", instructions: "Continue" })).rejects.toThrow("effort");
  await core.slack.switchExecution(started[4]!.spec.runId, { effort: null, instructions: "Use default effort" });
  complete(started[4]!.handle, "Returning to default effort.");
  await vi.waitFor(() => expect(started).toHaveLength(6));
  expect(started[5]!.spec.effort).toBeUndefined();
  expect(core.threads.list()[0]!.effort).toBeNull();
  complete(started[5]!.handle, "Using the default effort.");
});

it("accepts Autonomous in Slack settings and preserves it through execution switches", async () => {
  const started = providers();
  const { core, send } = await connected();
  core.slack.disconnectClient();
  const saved = (await core.slack.status()).client.config!;
  const config = SlackClientConfig.parse({ ...saved, permissionMode: "autonomous" });
  await core.slack.saveClient(config);
  expect((await core.slack.status()).client.config?.permissionMode).toBe("autonomous");
  await core.slack.connectClient();
  send("AUTONOMOUS", "Read this folder");
  await vi.waitFor(() => expect(started).toHaveLength(1), { timeout: 3000 });
  expect(started[0]!.spec.permissionMode).toBe("autonomous");
  expect(core.threads.list()[0]!.permissionMode).toBe("autonomous");
  await core.slack.switchExecution(started[0]!.spec.runId, { agent: "opencode", model: "openrouter/z-ai/glm-5.3", instructions: "Read this folder" });
  complete(started[0]!.handle, "Switching model.");
  await vi.waitFor(() => expect(started).toHaveLength(2));
  expect(started[1]!.spec.permissionMode).toBe("autonomous");
  complete(started[1]!.handle, "Finished.");
});

it("applies Review to an existing Autonomous Slack conversation and preserves it through switches", async () => {
  const started = providers();
  const { core, send } = await connected();
  core.slack.disconnectClient();
  const config = (await core.slack.status()).client.config!;
  await core.slack.saveClient({ ...config, permissionMode: "autonomous" });
  await core.slack.connectClient();
  send("POLICY-1", "Start here");
  await vi.waitFor(() => expect(started).toHaveLength(1), { timeout: 4000 });
  const threadId = core.threads.list()[0]!.id;
  expect(started[0]!.spec.permissionMode).toBe("autonomous");
  complete(started[0]!.handle, "Ready");
  await vi.waitFor(async () => expect((await core.slack.status()).client.busy).toBe(false), { timeout: 4000 });
  core.slack.disconnectClient();
  await core.slack.saveClient({ ...config, permissionMode: "review" });
  await core.slack.connectClient();
  send("POLICY-2", "Now inspect");
  await vi.waitFor(() => expect(started).toHaveLength(2), { timeout: 4000 });
  expect(core.threads.list()[0]!.id).toBe(threadId);
  expect(started[1]!.spec.permissionMode).toBe("review");
  await core.slack.switchExecution(started[1]!.spec.runId, { agent: "opencode", model: "openrouter/z-ai/glm-5.3", instructions: "Continue inspection" });
  complete(started[1]!.handle, "Switching");
  await vi.waitFor(() => expect(started).toHaveLength(3));
  expect(started[2]!.spec.permissionMode).toBe("review");
  complete(started[2]!.handle, "Done");
});

it("retains the Plan ceiling in saved relay settings and applies it to an existing Act conversation", async () => {
  const started = providers();
  const { core, send } = await connected();
  send("PLAN-1", "Start here");
  await vi.waitFor(() => expect(started).toHaveLength(1), { timeout: 4000 });
  complete(started[0]!.handle, "Ready");
  await vi.waitFor(async () => expect((await core.slack.status()).client.busy).toBe(false), { timeout: 4000 });
  core.slack.disconnectClient();
  const config = (await core.slack.status()).client.config!;
  await core.slack.saveClient({ ...config, mode: "plan", permissionMode: "review" });
  expect((await core.slack.status()).client.config?.mode).toBe("plan");
  await core.slack.connectClient();
  send("PLAN-2", "Investigate only");
  await vi.waitFor(() => expect(started).toHaveLength(2), { timeout: 4000 });
  expect(started[1]!.spec).toMatchObject({ mode: "plan", permissionMode: "review" });
  complete(started[1]!.handle, "Proposed plan");
});

const imagePng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=";
it.each(["direct", "relay"] as const)("imports Slack history and image-only replies into the model and persisted thread (%s)", async (mode) => {
  const started = providers();
  const core = mode === "relay" ? (await connected()).core : (await machine("Images")).core;
  if (mode === "direct") {
    await core.slack.saveDirect({ botToken: "xoxb-image-fixture", appToken: "xapp-image-fixture", userId: "UALICE", agent: "codex", permissionMode: "review" });
    await core.slack.connectDirect();
  }
  const originalFetch = globalThis.fetch;
  const downloads: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input).startsWith("https://files.slack.com/")) {
      downloads.push(String(input));
      expect(new Headers(init?.headers).get("Authorization")).toMatch(/^Bearer xoxb-/);
      return new Response(Buffer.from(imagePng, "base64"), { headers: { "Content-Type": "image/png" } });
    }
    return originalFetch(input, init);
  });
  const mention = body("IMAGE-MENTION", "UALICE", "compare these");
  fakeSlack.replies.mockResolvedValue({
    ok: true,
    messages: [
      { ts: "123.0", user: "UALICE", text: "Reference before the mention", files: [{ id: "FHISTORY", mimetype: "image/png" }] },
      { ts: mention.event.ts, user: "UALICE", text: mention.event.text, files: [{ id: "FCURRENT", mimetype: "image/png" }] },
    ],
  });
  const socket = fakeSlack.sockets.at(-1)!;
  socket.emit("app_mention", {
    // The relay case also exercises app_mention envelopes that omit their file descriptors.
    body: { ...mention, event: { ...mention.event, ...(mode === "direct" ? { files: [{ id: "FCURRENT", mimetype: "image/png" }] } : {}) } },
    ack: async () => {},
  });
  await vi.waitFor(() => expect(started).toHaveLength(1), { timeout: 4000 });
  const first = started[0]!;
  expect(first.spec.attachments).toHaveLength(2);
  for (const path of first.spec.attachments!) expect((await readFile(path)).toString("base64")).toBe(imagePng);
  expect(first.spec.prompt).toContain("Reference before the mention");
  expect(first.spec.prompt).not.toContain("files.slack.com");
  expect(first.spec.prompt).not.toContain("xoxb-");
  const messages = core.threads.messages(core.threads.list()[0]!.id);
  expect(messages.map((m) => m.attachments?.length)).toEqual([1, 1]);
  complete(first.handle, "I can see both images.");
  await vi.waitFor(() => expect(slackMessages().some(([v]) => JSON.stringify(v).includes("I can see both images."))).toBe(true), { timeout: 4000 });
  socket.emit("message", {
    body: {
      event_id: "IMAGE-ONLY",
      team_id: "TTEAM",
      event: { type: "message", subtype: "file_share", user: "UALICE", channel: "CTEST", ts: "124.0", thread_ts: "123.0", text: "", files: [{ id: "FONLY", mimetype: "image/png" }] },
    },
    ack: async () => {},
  });
  await vi.waitFor(() => expect(started).toHaveLength(2), { timeout: 4000 });
  expect(started[1]!.spec.attachments).toHaveLength(3);
  expect(downloads).toHaveLength(3);
  const updated = core.threads.messages(core.threads.list()[0]!.id);
  expect(updated).toHaveLength(3);
  expect(updated.at(-1)?.attachments).toHaveLength(1);
  complete(started[1]!.handle, "Received the new image.");
});

it("shows a missing image scope in the local transcript and model context", async () => {
  const started = providers();
  const { core, send } = await connected();
  fakeSlack.file.mockRejectedValueOnce({ data: { error: "missing_scope" }, token: "xoxb-secret" });
  fakeSlack.replies.mockResolvedValue({ ok: true, messages: [{ ts: "123.0", user: "UALICE", text: "reference", files: [{ id: "FIMAGE" }] }] });
  send("NO-IMAGE-SCOPE", "can you see my image?");
  await vi.waitFor(() => expect(started).toHaveLength(1), { timeout: 4000 });
  expect(started[0]!.spec.attachments ?? []).toEqual([]);
  expect(started[0]!.spec.prompt).toContain("files:read");
  expect(started[0]!.spec.prompt).not.toContain("xoxb-secret");
  expect(core.threads.messages(core.threads.list()[0]!.id)).toEqual(expect.arrayContaining([expect.objectContaining({ role: "system", text: expect.stringContaining("files:read") })]));
  complete(started[0]!.handle, "Please add files:read and reinstall your Slack app.");
});

it("reports a lost Slack connection until a reconnect succeeds, retrying after a failed attempt", async () => {
  const { core } = await machine("Personal");
  await core.slack.saveDirect({ botToken: "xoxb-personal-secret", appToken: "xapp-personal-secret", userId: "UALICE", agent: "codex", model: "gpt-6-astra", permissionMode: "review" });
  await core.slack.connectDirect();
  const socket = fakeSlack.sockets.at(-1)! as import("node:events").EventEmitter & { start: () => Promise<void> };
  const start = vi.spyOn(socket, "start").mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND slack.com"));
  socket.emit("disconnected");
  expect((await core.slack.status()).direct).toMatchObject({ connected: false, error: "Slack connection lost. Reconnecting…" });
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2), { timeout: 5000 });
  await vi.waitFor(async () => expect((await core.slack.status()).direct).toMatchObject({ connected: true, error: null }));
});
