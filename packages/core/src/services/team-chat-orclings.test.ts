import { standIn, type StandIn } from "@openorc/hosted/testing";
import { defaultOrclingLook } from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OpenOrc } from "../openorc.js";
import { rpcClient } from "../rpc-test-client.js";

const OWNER = "theo@example.com",
  TEAMMATE = "mara@example.com";
const binaries = {
  claude: "/usr/bin/false",
  codex: "/usr/bin/false",
  opencode: "/usr/bin/false",
  omp: "/usr/bin/false",
  cursor: "/usr/bin/false",
  pi: "/usr/bin/false",
  antigravity: "/usr/bin/false",
  fx: "/usr/bin/false",
};

let stand: StandIn;
let folder: string;
let core: OpenOrc;
let spaceId: string;
const call = rpcClient(() => core);

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  Object.assign(stand.chat, { enabled: true, orclingEnabled: true });
  for (const email of [OWNER, TEAMMATE]) stand.setBilling(email, { pro: true, standing: "live", at: new Date(Date.now() + 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
  stand.setPerson(OWNER, { name: "Theo Laurent", image: null });
  stand.setPerson(TEAMMATE, { name: "Mara Okafor", image: null });
  spaceId = stand.addTeam("Birch Studio", [OWNER, TEAMMATE]);
  folder = await mkdtemp(path.join(tmpdir(), "openorc-chat-orcling-"));
  let stored: string | null = null;
  core = await OpenOrc.create({
    dataDir: path.join(folder, "data"),
    transport: { push: () => undefined },
    accountServer: stand.url,
    accountSecrets: { load: async () => stored, save: async (value) => void (stored = value) },
    openBrowser: (url) => void (new URL(url).pathname === "/sign-in" && fetch(stand.signInPage(url, OWNER))),
    shellProbe: async () => ({ path: process.env.PATH ?? "", binaries }),
  });
  await call("account.signIn", {});
  await vi.waitFor(async () => expect(await call("spaces.status", {})).toMatchObject({ state: "ready" }), { timeout: 5_000 });
});

afterEach(async () => {
  await core.close();
  await stand.close();
  await rm(folder, { recursive: true, force: true });
});

async function setUp() {
  const rini = await call("orclings.create", {
    draft: { name: "Rini", look: defaultOrclingLook, settings: { agent: "claude", model: "claude-opus-fixture", effort: null, fastMode: false }, permission: "allow" },
  });
  const general = stand.chat.seed(spaceId, { name: "general" });
  const target = { spaceId, conversationId: general.id };
  return { rini, target };
}
const timeline = async (target: { spaceId: string; conversationId: string }) => (await call("teamChat.timeline", target)).messages;

it("sends a message that calls the owner's Orcling and answers once, as the Orcling, on its own model with only the conversation", async () => {
  const { rini, target } = await setUp();
  const speak = vi.spyOn(core.textGeneration, "speak").mockResolvedValue({ kind: "answered", text: '{"text":"Ship it after the smoke test."}', model: { provider: "claude", label: "Fixture" } });
  const callId = randomUUID();
  const sent = await call("teamChat.send", { ...target, id: randomUUID(), body: "@Rini should we ship?", orcling: { callId, localOrclingId: rini.id } });
  expect(sent.call).toMatchObject({ id: callId, name: "Rini", localOrclingId: rini.id });
  await vi.waitFor(async () => expect((await timeline(target)).at(-1)?.actor).toMatchObject({ kind: "orcling", name: "Rini", callId, owner: { name: "Theo Laurent" } }), { timeout: 5_000 });
  const messages = await timeline(target);
  expect(messages.map((message) => [message.body, message.call?.state ?? null])).toEqual([
    ["@Rini should we ship?", "answered"],
    ["Ship it after the smoke test.", null],
  ]);
  expect(speak).toHaveBeenCalledTimes(1);
  const asked = speak.mock.calls[0]![0];
  expect(asked).toMatchObject({ agent: "claude", model: "claude-opus-fixture" });
  expect(asked.system).toContain("# You are Rini");
  expect(asked.system).not.toContain("orcling_remember");
  expect(asked.system).toContain("can't make pictures");
  expect(asked.pictures).toBeUndefined();
  expect(asked.prompt).toContain("Theo Laurent: @Rini should we ship?");
});

it("sends the pictures an Orcling drew with its answer, when its agent makes pictures", async () => {
  const { target } = await setUp();
  const pix = await call("orclings.create", {
    draft: { name: "Pix", look: defaultOrclingLook, settings: { agent: "codex", model: "gpt-fixture", effort: null, fastMode: false }, permission: "allow" },
  });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const speak = vi.spyOn(core.textGeneration, "speak").mockImplementation(async (request) => {
    await writeFile(path.join(request.pictures!, "picture-1.png"), png);
    return { kind: "answered", text: '{"text":"Here it is."}', model: { provider: "codex", label: "Fixture" } };
  });
  await call("teamChat.send", { ...target, id: randomUUID(), body: "@Pix draw the plan", orcling: { callId: randomUUID(), localOrclingId: pix.id } });
  await vi.waitFor(
    async () => expect((await timeline(target)).at(-1)).toMatchObject({ actor: { kind: "orcling", name: "Pix" }, body: "Here it is.", files: [{ name: "picture-1.png", kind: "image" }] }),
    {
      timeout: 5_000,
    },
  );
  expect(speak.mock.calls[0]![0].system).toContain("you can make a picture");
  await expect(access(speak.mock.calls[0]![0].pictures!)).rejects.toThrow();
});

it("tells only the owner why the Orcling couldn't answer, and answers when the owner tries again", async () => {
  const { rini, target } = await setUp();
  const speak = vi.spyOn(core.textGeneration, "speak").mockResolvedValueOnce({ kind: "unavailable", reason: "Claude is unavailable. Check its connection in Settings." });
  const callId = randomUUID();
  await call("teamChat.send", { ...target, id: randomUUID(), body: "@Rini summarize", orcling: { callId, localOrclingId: rini.id } });
  await vi.waitFor(async () => expect((await timeline(target)).at(-1)?.call?.state).toBe("failed"), { timeout: 5_000 });
  expect(await call("teamChat.orclingCall", { spaceId, callId })).toMatchObject({ reason: "Claude is unavailable. Check its connection in Settings.", canRetry: true });
  speak.mockResolvedValueOnce({ kind: "answered", text: "Here is the summary.", model: { provider: "claude", label: "Fixture" } });
  await call("teamChat.retryOrclingCall", { ...target, callId });
  await vi.waitFor(async () => expect((await timeline(target)).at(-1)?.body).toBe("Here is the summary."), { timeout: 5_000 });
  expect(speak).toHaveBeenCalledTimes(2);
});

it("refuses to call an Orcling this Mac doesn't have, and sends nothing", async () => {
  const { target } = await setUp();
  await expect(call("teamChat.send", { ...target, id: randomUUID(), body: "@Ghost hi", orcling: { callId: randomUUID(), localOrclingId: "no-such-orcling" } })).rejects.toThrow();
  expect(await timeline(target)).toEqual([]);
});
