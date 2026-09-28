import { expect, it } from "vitest";
import { taskBaseLabel, taskCompareUrl, taskPublicationBlockedReason } from "./task-review-availability";

it("uses an available export report during a failed refresh and preserves empty supplied reasons", () => {
  const input = { hasOwner: true, isError: true, isPending: true };
  expect(taskPublicationBlockedReason({ ...input, team: { export: { allowed: true, reason: null, branch: "assignment" } } })).toBeNull();
  expect(taskPublicationBlockedReason({ ...input, team: { export: { allowed: false, reason: "", branch: "assignment" } } })).toBe("");
  expect(taskPublicationBlockedReason({ ...input, team: {} })).toBe("Publish integrated team changes from the main team conversation. This assignment’s workspace is kept for review.");
  expect(taskPublicationBlockedReason({ ...input, team: null })).toBe("Task ownership could not be checked. Retry before changing its workspace or sending comments.");
  expect(taskPublicationBlockedReason({ ...input, isError: false, team: undefined })).toBe("Checking task ownership…");
  expect(taskPublicationBlockedReason({ ...input, hasOwner: false, team: null })).toBeNull();
});

it("compares an assignment commit base against the default branch without losing a named base", () => {
  const project = { gitRemote: "git@github.com:example/repo.git", defaultBranch: "release/stable" };
  const task = { baseRef: "a".repeat(40), branch: "assignment/topic" };
  expect(taskBaseLabel(task, project)).toBe("release/stable");
  expect(taskCompareUrl(project, task)).toBe("https://github.com/example/repo/compare/release%2Fstable...assignment%2Ftopic?expand=1");
  expect(taskBaseLabel({ baseRef: "custom" }, project)).toBe("custom");
  expect(taskCompareUrl({ ...project, gitRemote: "git@gitlab.com:example/repo.git" }, task)).toBeNull();
});
