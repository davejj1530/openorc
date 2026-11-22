import { expect, it } from "vitest";
import { TaskButton } from "./domain.js";
import { projectRpcParams } from "./projects.js";

const settings = projectRpcParams["projects.updateSettings"];

it("leaves a project's Claude accounts out of a settings patch from a client that does not know them", () => {
  const parsed = settings.parse({ id: "p", settings: { branchPrefix: "openorc", worktreeInclude: [], setupScript: null, somethingNewer: true } });
  expect(parsed.settings).toEqual({ branchPrefix: "openorc", worktreeInclude: [], setupScript: null });
  expect("claudeAccounts" in parsed.settings).toBe(false);
});

it("takes a project's Claude accounts, or null to follow the app's", () => {
  const claudeAccounts = { only: true, accountIds: ["work"], defaultId: "work", autoSwitch: false };
  expect(settings.parse({ id: "p", settings: { claudeAccounts } }).settings).toEqual({ claudeAccounts });
  expect(settings.parse({ id: "p", settings: { claudeAccounts: null } }).settings).toEqual({ claudeAccounts: null });
  expect(() => settings.parse({ id: "p", settings: { claudeAccounts: { ...claudeAccounts, accountIds: Array.from({ length: 51 }, (_, i) => `a${i}`) } } })).toThrow();
  expect(() => settings.parse({ id: "p", settings: { claudeAccounts: { only: true, accountIds: [""], defaultId: null, autoSwitch: false } } })).toThrow();
});

it("takes task buttons with their own model and account, or without one as saved before", () => {
  const review = { id: "review", label: "Review", prompt: "Review this task's changes.", runsIn: "new", mode: "plan" };
  const choice = { agent: "claude", model: "claude-opus-4-7", effort: "high", claudeAccountId: "work" };
  expect(settings.parse({ id: "p", settings: { taskButtons: [review] } }).settings.taskButtons).toEqual([review]);
  expect(TaskButton.parse({ ...review, choice }).choice).toEqual(choice);
  expect(TaskButton.parse({ ...review, choice: { agent: "codex", model: "gpt-5.5", effort: null } }).choice).toEqual({ agent: "codex", model: "gpt-5.5", effort: null });
  expect(() => TaskButton.parse({ ...review, choice: { ...choice, model: "" } })).toThrow();
  expect(TaskButton.parse({ ...review, mode: "act" }).mode).toBe("thread");
  expect(TaskButton.parse({ ...review, includeTask: false }).includeTask).toBe(false);
  expect(TaskButton.parse({ ...review, mode: "autonomous" }).mode).toBe("autonomous");
  expect(() => TaskButton.parse({ ...review, mode: "act-now" })).toThrow();
  expect(() => TaskButton.parse({ ...review, choice: { ...choice, orclingId: "o" } })).toThrow();
});
