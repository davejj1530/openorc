import { Db, projects } from "@openorc/db";
import type { ThreadChoice } from "@openorc/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CheckWriter } from "./automation-check-writer.js";
import type { AutomationSources } from "./automation-sources.js";
import type { Completion } from "./text-generation.js";

const choice: ThreadChoice = { agent: "claude", model: "claude-sonnet-5-5", effort: null };
let folder: string;
let db: Db;
let projectId: string;
const speak = vi.fn<(request: { prompt: string }) => Promise<Completion>>();
const check = vi.fn<AutomationSources["check"]>();
const answered = (answer: object): Completion => ({ kind: "answered", text: JSON.stringify(answer), model: { provider: "claude", label: "Sonnet" } });

beforeEach(() => {
  folder = mkdtempSync(path.join(os.tmpdir(), "openorc-check-writer-"));
  db = Db.open(path.join(folder, "data.sqlite"));
  projectId = projects.insert(db, { name: "studio", rootPath: folder, defaultBranch: "main", gitRemote: "git@github.com:acme/studio.git", settings: {} }).id;
});
afterEach(() => {
  db.close();
  rmSync(folder, { recursive: true, force: true });
  vi.resetAllMocks();
});

const writer = () => new CheckWriter(db, { text: { speak }, sources: { check, pulls: vi.fn() } });

it("writes a check from the person's words and the project's repository, and says what it finds now", async () => {
  speak.mockResolvedValueOnce(answered({ command: "gh issue list --label bug", everyMinutes: 4.6, problem: "" }));
  check.mockResolvedValueOnce(["12\tThe login page is blank", "15"]);
  const written = await writer().write({ projectId, what: "an issue opens with the bug label", choice });
  expect(written).toEqual({ state: "written", command: "gh issue list --label bug", everyMinutes: 5, found: ["The login page is blank", "15"] });
  expect(speak.mock.calls[0]![0].prompt).toContain("git@github.com:acme/studio.git");
  expect(check).toHaveBeenCalledWith(folder, "gh issue list --label bug");
});

it("hands a command that does not run back to the agent once, with why, and gives up after that", async () => {
  speak.mockResolvedValueOnce(answered({ command: "gh issues", everyMinutes: 5, problem: "" })).mockResolvedValueOnce(answered({ command: "gh issue list", everyMinutes: 5, problem: "" }));
  check.mockRejectedValueOnce(new Error('Its check did not run: unknown command "issues"')).mockResolvedValueOnce([]);
  expect(await writer().write({ projectId, what: "new issues", choice })).toMatchObject({ state: "written", command: "gh issue list", found: [] });
  expect(speak.mock.calls[1]![0].prompt).toContain('unknown command "issues"');

  speak.mockResolvedValue(answered({ command: "false", everyMinutes: 5, problem: "" }));
  check.mockRejectedValue(new Error("Its check did not run."));
  expect(await writer().write({ projectId, what: "new issues", choice })).toEqual({ state: "failed", reason: "The check it wrote did not run. Its check did not run.", command: "false" });
  expect(check).toHaveBeenCalledTimes(4);
});

it("says why when the agent cannot watch for it, or cannot be reached, and never runs anything then", async () => {
  speak.mockResolvedValueOnce(answered({ command: "", everyMinutes: 5, problem: "A command cannot read your email." }));
  expect(await writer().write({ projectId, what: "an email arrives", choice })).toEqual({ state: "failed", reason: "A command cannot read your email.", command: null });
  speak.mockResolvedValueOnce({ kind: "unavailable", reason: "Claude is unavailable. Check its connection in Settings." });
  expect(await writer().write({ projectId, what: "new issues", choice })).toMatchObject({ state: "failed", reason: "Claude is unavailable. Check its connection in Settings." });
  expect(check).not.toHaveBeenCalled();
});

it("tries a command the person wrote, and says why one does not run", async () => {
  check.mockResolvedValueOnce(["a\tOne"]).mockRejectedValueOnce(new Error("Its check did not run: it did not finish in time."));
  expect(await writer().try(projectId, "echo a")).toEqual({ state: "ran", found: ["One"] });
  expect(await writer().try(projectId, "sleep 100")).toEqual({ state: "failed", reason: "Its check did not run: it did not finish in time." });
});
