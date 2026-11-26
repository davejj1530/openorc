import { Db, threads, type WatchedAutomation } from "@openorc/db";
import { WORKSPACE_ID } from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TriggerPrograms, type ProgramEvent } from "./trigger-programs.js";
import { TriggerValues } from "./trigger-values.js";
import { ensureWorkspaceHome } from "./workspace-home.js";

/** A program starts in a login shell, which takes its time on a busy machine. */
const WAIT = { timeout: 10_000 };
let folder: string;
let db: Db;
let programs: TriggerPrograms;
let kept: string | null;
const fire = vi.fn<(automationId: string, event: ProgramEvent) => void>();
const report = vi.fn<(automationId: string, problem: string | null) => void>();
const start = vi.fn();

beforeEach(() => {
  folder = mkdtempSync(path.join(os.tmpdir(), "openorc-trigger-programs-"));
  db = Db.open(path.join(folder, "data.sqlite"));
  kept = null;
  const values = new TriggerValues({ load: async () => kept, save: async (value) => void (kept = value) });
  programs = new TriggerPrograms(db, { dataDir: folder, values, threads: { start }, fire, report, invalidate: () => {}, log: { info: () => {}, warn: () => {}, error: () => {} } as never });
});
afterEach(() => {
  programs.stop();
  db.close();
  rmSync(folder, { recursive: true, force: true });
  vi.resetAllMocks();
});

/** A program written as its agent would: its folder, and trigger.json naming its command and values. */
function written(run: string, env: { name: string; about: string }[] = []): string {
  const id = randomUUID();
  mkdirSync(programs.folder(id), { recursive: true });
  writeFileSync(path.join(programs.folder(id), "trigger.json"), JSON.stringify({ run, env }));
  return id;
}
const watching = (id: string): WatchedAutomation[] => [{ id: "automation", trigger: { kind: "program", id, what: "Slack messages" } } as WatchedAutomation];

it("runs a program for its automation with the values it names, and each line of JSON it prints is an event", async () => {
  const id = written(`echo '{"id":"'"$SLACK_TOKEN"'","title":"Dana messaged you","detail":"Lunch?"}'; echo Connected; sleep 30`, [{ name: "SLACK_TOKEN", about: "From your Slack app." }]);
  await programs.setValue(id, "SLACK_TOKEN", "xoxb-1", watching(id));
  await vi.waitFor(() => expect(fire).toHaveBeenCalledWith("automation", { key: "program:xoxb-1", title: "Dana messaged you", detail: "Lunch?" }), WAIT);
  await vi.waitFor(
    async () =>
      expect((await programs.state(id)).recent.map((line) => [line.text, line.event])).toEqual([
        ["Dana messaged you", true],
        ["Connected", false],
      ]),
    WAIT,
  );
  expect(report).toHaveBeenLastCalledWith("automation", null);
  expect(await programs.state(id)).toMatchObject({
    run: expect.stringContaining("echo"),
    env: [{ name: "SLACK_TOKEN", about: "From your Slack app.", added: true }],
    state: "listening",
    problem: null,
  });
});

it("waits for a value it names until the person adds it", async () => {
  const id = written(`echo '{"id":"1","title":"Ready"}'; sleep 30`, [{ name: "TOKEN", about: "" }]);
  programs.sync(watching(id));
  await vi.waitFor(() => expect(report).toHaveBeenCalledWith("automation", "Add TOKEN to start it."), WAIT);
  expect(fire).not.toHaveBeenCalled();
  await programs.setValue(id, "TOKEN", "secret", watching(id));
  await vi.waitFor(() => expect(fire).toHaveBeenCalledWith("automation", expect.objectContaining({ key: "program:1" })), WAIT);
});

it("says why a program stopped, in its own last words", async () => {
  const id = written("echo 'The token was refused.' >&2; exit 3");
  programs.sync(watching(id));
  await vi.waitFor(() => expect(report).toHaveBeenLastCalledWith("automation", "It stopped. The token was refused."), WAIT);
  expect((await programs.state(id)).state).toBe("stopped");
});

it("tries a program, showing what it prints and acting on none of it, until it is stopped", async () => {
  const id = written(`echo '{"id":"1","title":"A new file"}'; sleep 30`);
  await programs.try(id, true);
  await vi.waitFor(async () => expect((await programs.state(id)).recent).toEqual([expect.objectContaining({ text: "A new file", event: true })]), WAIT);
  expect((await programs.state(id)).state).toBe("trying");
  await programs.try(id, false);
  expect(await programs.state(id)).toMatchObject({ state: "off", recent: [expect.objectContaining({ text: "A new file" })] });
  expect(fire).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});

it("has an agent write a new program in a folder of its own, told what to watch for and the one rule of what it prints", async () => {
  start.mockResolvedValue({ thread: { id: "thread-1" }, run: null });
  const { id, threadId } = await programs.write({ projectId: "studio", what: "someone messages me on Slack", choice: { agent: "claude", model: "claude-sonnet-5-5", effort: null } });
  expect(threadId).toBe("thread-1");
  const asked = start.mock.calls[0]![0] as { projectId: string; workingDirectory: string; prompt: string; agent: string };
  expect(asked).toMatchObject({ projectId: WORKSPACE_ID, workingDirectory: programs.folder(id), agent: "claude" });
  expect(asked.prompt).toContain("It should notice: someone messages me on Slack.");
  expect(asked.prompt).toContain("trigger.json");
  expect((await programs.state(id)).run).toBeNull();
});

it("starts a program its agent finishes after the automation was switched on, at the next look", async () => {
  const id = randomUUID();
  mkdirSync(programs.folder(id), { recursive: true });
  programs.sync(watching(id));
  await vi.waitFor(() => expect(report).toHaveBeenCalledWith("automation", "Its program isn't written yet."), WAIT);
  writeFileSync(path.join(programs.folder(id), "trigger.json"), JSON.stringify({ run: `echo '{"id":"1","title":"Written"}'; sleep 30` }));
  programs.sync(watching(id));
  await vi.waitFor(() => expect(fire).toHaveBeenCalledWith("automation", expect.objectContaining({ key: "program:1" })), WAIT);
});

it("finds the thread its agent writes it in, by the folder as the system resolves it", async () => {
  const id = written("sleep 1");
  await ensureWorkspaceHome(db, folder);
  const thread = threads.insert(db, { projectId: WORKSPACE_ID, title: "Trigger", agent: "claude", model: null, mode: "act", permissionMode: "trusted" });
  threads.update(db, thread.id, { workingDirectory: realpathSync(programs.folder(id)) });
  expect((await programs.state(id)).threadId).toBe(thread.id);
});
