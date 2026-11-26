import { expect, it } from "vitest";
import { everyWords, stepsWords, triggerWords } from "./automation-words.js";

it("says what an automation waits for, whose pull requests it reads, and on a task that it is the task's own", () => {
  expect(triggerWords({ kind: "pull_request", on: "checks_failed", scope: "ours" })).toBe("When checks fail on a pull request from your threads");
  expect(triggerWords({ kind: "pull_request", on: "opened", scope: "any" })).toBe("When a pull request opens");
  expect(triggerWords({ kind: "pull_request", on: "merged", scope: "ours" }, true)).toBe("When its pull request merges");
  expect(triggerWords({ kind: "task_created" })).toBe("When a task is created");
  expect(triggerWords({ kind: "check", what: "An issue was opened", command: "gh issue list", everyMinutes: 5 })).toBe("When: An issue was opened");
});

it("lists the steps in order, naming a column by the board's own name while it is there", () => {
  const columns = [{ id: "c1", name: "Inbox" }];
  const actions = [
    { kind: "task" as const, stage: "backlog" as const, columnId: "c1" },
    { kind: "agent" as const, prompt: "Triage it.", choice: { agent: "codex" as const, model: "m", effort: null } },
    { kind: "move" as const, stage: "review" as const, columnId: "gone" },
  ];
  expect(stepsWords({ actions }, columns)).toBe("Create a task in Inbox, then start Codex, then move the task to Review");
});

it("says how often a check runs", () => {
  expect([1, 5, 60, 360, 1440, 10_080].map(everyWords)).toEqual(["every minute", "every 5 minutes", "every hour", "every 6 hours", "every day", "every 7 days"]);
});
