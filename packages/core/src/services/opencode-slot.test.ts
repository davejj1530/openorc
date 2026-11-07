import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hostHome, SessionRefused, sessionSlots, type SessionId } from "@openorc/agents";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FAKE_OPENCODE } from "../test-fixtures/fake-opencode.js";

const slot = sessionSlots.opencode;
const ROOT = "ses_root1" as SessionId;
const CHILD = "ses_child1";
let root: string;
let binary: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-opencode-slot-")));
  binary = path.join(root, "opencode");
  await writeFile(binary, FAKE_OPENCODE);
  await chmod(binary, 0o755);
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** OpenCode's data folder at a named home, apart from the person's own. */
const home = (name: string) =>
  hostHome({
    agent: "opencode",
    userHome: path.join(root, name),
    env: { XDG_DATA_HOME: path.join(root, name, "data") },
    binary,
    processEnv: { PATH: process.env["PATH"] ?? "", HOME: path.join(root, name) },
  });
const session = (id: string, directory: string, messages: string[], parentID?: string) => ({
  info: { id, ...(parentID ? { parentID } : {}), location: { directory }, time: { created: 1, updated: 2 } },
  messages: messages.map((text, index) => ({ id: `msg_${id}_${index}`, type: index % 2 ? "assistant" : "user", text })),
});
async function hold(name: string, value: ReturnType<typeof session>): Promise<void> {
  const folder = path.join(root, name, "data", "fake-opencode");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, `${value.info.id}.json`), JSON.stringify(value));
}
const held = async (name: string, id: string) => JSON.parse(await readFile(path.join(root, name, "data", "fake-opencode", `${id}.json`), "utf8"));

it("moves a session with its subagent's session, parents first, to resume from the new folder, its digest unchanged", async () => {
  const mac = path.join(root, "mac-worktree");
  const cloud = path.join(root, "cloud-repo");
  await Promise.all([mkdir(mac), mkdir(cloud)]);
  await hold("mac", session(ROOT, mac, ["Start", "Done"]));
  await hold("mac", session(CHILD, mac, ["Look around"], ROOT));
  const saved = await slot.export(home("mac"), { sessionId: ROOT, cwd: mac, children: [CHILD, "ses_never_saved"] });
  expect(saved?.parts.map((part) => part.name)).toEqual([`${ROOT}.json`, `${CHILD}.json`]);

  const digest = await slot.import(home("cloud"), saved!, cloud);
  expect((await held("cloud", CHILD)).info).toMatchObject({ parentID: ROOT, location: { directory: cloud } });
  const there = await slot.export(home("cloud"), { sessionId: ROOT, cwd: cloud, children: [CHILD] });
  expect(slot.digest(there!)).toBe(digest);
  expect(await slot.check(home("cloud") as never, { sessionId: ROOT, cwd: cloud, children: [] })).toBeNull();
  expect(await slot.check(home("cloud") as never, { sessionId: ROOT, cwd: mac, children: [] })).toContain("does not belong to cwd");
});

it("replaces a copy already there with its children, since OpenCode imports no session twice", async () => {
  const folder = path.join(root, "repo");
  await mkdir(folder);
  await hold("mac", session(ROOT, folder, ["Start", "Done", "More in the cloud", "Done again"]));
  await hold("back", session(ROOT, folder, ["Start", "Done"]));
  await hold("back", session(CHILD, folder, ["An older look"], ROOT));
  const saved = await slot.export(home("mac"), { sessionId: ROOT, cwd: folder, children: [] });
  await slot.import(home("back"), saved!, folder);
  expect((await held("back", ROOT)).messages).toHaveLength(4);
  await expect(held("back", CHILD)).rejects.toThrow();
});

it("refuses a part it cannot name, or a document OpenCode did not export, before writing anything", async () => {
  const folder = path.join(root, "repo");
  await mkdir(folder);
  const doc = Buffer.from(JSON.stringify(session(ROOT, folder, ["Start"])));
  const base = { agent: "opencode" as const, format: 1, cliVersion: null, sessionId: ROOT, meta: {} };
  for (const name of ["../escape.json", "ses_x/../../y.json", "auth.json", "opencode.db"])
    await expect(
      slot.import(
        home("cloud"),
        {
          ...base,
          parts: [
            { name: `${ROOT}.json`, bytes: doc },
            { name, bytes: doc },
          ],
        },
        folder,
      ),
    ).rejects.toThrow("cannot have");
  await expect(slot.import(home("cloud"), { ...base, parts: [{ name: `${ROOT}.json`, bytes: Buffer.from('{"rows":[]}') }] }, folder)).rejects.toThrow(SessionRefused);
  await expect(held("cloud", ROOT)).rejects.toThrow();
});

it("continues a session in one headless run: approving on its own only when autonomous, and in Plan without any tool that changes files", () => {
  const settings = { model: "openrouter/acme/fast", effort: "high", mode: "act" as const, permissionMode: "autonomous" as const };
  const run = slot.continueOnce({ sessionId: ROOT }, "Carry on", settings);
  expect([run.cmd, ...run.args]).toEqual([
    "sh",
    "-c",
    'exec opencode "$@" < /dev/null',
    "sh",
    "run",
    "--standalone",
    "--session",
    ROOT,
    "--format",
    "json",
    "-m",
    "openrouter/acme/fast#high",
    "--auto",
    "Carry on",
  ]);
  expect(slot.continueOnce({ sessionId: ROOT }, "x", { ...settings, permissionMode: "trusted" }).args).not.toContain("--auto");
  const plan = slot.continueOnce({ sessionId: ROOT }, "x", { ...settings, mode: "plan" });
  expect(plan.args).not.toContain("--auto");
  const config = JSON.parse(plan.env!({ OPENCODE_CONFIG_CONTENT: '{"provider":{"openrouter":{"options":{"apiKey":"k"}}}}' })["OPENCODE_CONFIG_CONTENT"]!);
  expect(config).toMatchObject({ default_agent: "plan", provider: { openrouter: { options: { apiKey: "k" } } } });
  expect(config.agents.plan.permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
});
