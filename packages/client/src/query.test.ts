import { fileReads, type FolderPath, type RpcMethod } from "@openorc/protocol";
import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { invalidatesFor, tagsFor } from "./query-tags.js";
import { testClient } from "./test-fixtures/fake-connection.js";

const { queryClient, invalidateTags } = testClient().client;

/** Every write and the reads that must refresh once it lands. */
const contract: Array<[RpcMethod, RpcMethod[]]> = [
  ["memory.settings.set", ["memory.settings.get"]],
  ["memory.update", ["memory.list", "memory.search", "memory.forTask"]],
  ["memory.remove", ["memory.list"]],
  ["tasks.create", ["tasks.list", "inbox.list"]],
  ["tasks.update", ["tasks.list", "tasks.get"]],
  ["tasks.delete", ["tasks.list", "inbox.list"]],
  ["projects.import", ["projects.list"]],
  ["projects.remove", ["projects.list", "projects.get"]],
  ["projects.updateSettings", ["projects.list", "projects.get"]],
  ["runs.start", ["runs.listForTask", "tasks.get", "inbox.list"]],
  // Diffs are not polled: every write to a checkout refreshes each view of it.
  ["review.commit", ["review.diff", "git.log", "review.snapshots", "review.threadDiff", "review.projectDiff"]],
  ["review.push", ["git.log"]],
  ["review.comments.add", ["review.comments.list"]],
  ["review.comments.send", ["review.comments.list", "threads.get", "tasks.get"]],
  ["review.markReviewed", ["tasks.get", "review.diff"]],
  ["workspace.cleanup", ["tasks.get", "workspace.usage"]],
  ["threads.start", ["threads.list"]],
  ["threads.update", ["threads.list", "threads.get", "runs.listForThread"]],
  ["threads.delete", ["threads.list", "tasks.list", "inbox.list"]],
  ["tasks.start", ["tasks.get", "threads.list", "inbox.list"]],
  ["runs.start", ["runs.listForThread", "threads.get"]],
  ["threads.fork", ["threads.list"]],
  ["threads.moveWorkspace", ["threads.get", "review.threadDiff", "review.projectDiff", "git.threadLog"]],
  ["threads.restore", ["review.threadDiff", "review.projectDiff", "threads.checkpoints"]],
  ["threads.queue", ["threads.get", "threads.list", "threads.lastMessage"]],
  ["threads.unqueue", ["threads.get"]],
  ["threads.compact", ["runs.listForThread", "threads.get"]],
  ["review.comments.add", []],
  ["review.comments.remove", []],
  ["threads.update", []],
  ["threads.delete", []],
  ["threads.import", ["threads.list", "threads.importable"]],
  ["review.commitThread", ["review.threadDiff", "git.threadLog", "git.threadPushState", "threads.get"]],
  ["review.pushThread", ["git.threadLog", "git.threadPushState"]],
  ["review.commitThread", ["review.projectDiff"]],
  ["review.commitProject", ["review.threadDiff", "review.projectDiff"]],
  ["review.createThreadPr", ["threads.get", "threads.list"]],
  ["app.settings.set", ["app.settings.get"]],
  ["schedules.create", ["schedules.list"]],
  ["schedules.update", ["schedules.list"]],
  ["schedules.delete", ["schedules.list"]],
  ["schedules.run", ["schedules.list", "threads.list"]],
  ["schedules.trigger", ["schedules.list", "threads.list"]],
  ["memory.promote", ["memory.list"]],
  ["textGeneration.settings.set", ["textGeneration.settings.get"]],
  ["pulls.review.comment", ["pulls.review.get"]],
  ["pulls.review.editComment", ["pulls.review.get"]],
  ["pulls.review.removeComment", ["pulls.review.get"]],
  ["pulls.review.summary", ["pulls.review.get"]],
  ["pulls.review.discard", ["pulls.review.get"]],
  ["pulls.review.start", ["pulls.review.get", "threads.list", "threads.get"]],
  // A posted review changes the pull request's review decision on GitHub.
  ["pulls.review.submit", ["pulls.review.get", "pulls.list", "pulls.get"]],
  ["reviewerApp.setup", ["reviewerApp.get"]],
  ["reviewerApp.cancelSetup", ["reviewerApp.get"]],
  ["reviewerApp.configure", ["reviewerApp.get"]],
  ["reviewerApp.remove", ["reviewerApp.get"]],
  ["devices.setup", ["devices.status", "devices.list"]],
  ["devices.settings.set", ["devices.status", "devices.list"]],
  ["devices.boot", ["devices.list"]],
  ["devices.shutdown", ["devices.list"]],
  ["remote.configure", ["remote.status"]],
  ["remote.pairing.begin", ["remote.status"]],
  ["remote.pairing.cancel", ["remote.status"]],
  ["remote.devices.remove", ["remote.status"]],
  ["skills.writeFile", ["skills.list", "skills.files", "skills.readFile"]],
  ["skills.setEnabled", ["skills.list", "cloud.skills"]],
  ["skills.setIcon", ["skills.list", "skills.files", "skills.readFile"]],
  ["skills.create", ["skills.list", "cloud.skills"]],
  ["skills.import", ["skills.list", "cloud.skills"]],
  ["skills.remove", ["skills.list", "skills.files", "cloud.skills"]],
];

const params = { id: "t1", taskId: "t1", threadId: "t1", projectId: "p1", scope: { kind: "thread" as const, id: "t1" }, path: "README.md", query: "", skill: "/skills/notes/SKILL.md" };

describe("query cache tags", () => {
  it("every write refreshes the reads it affects", () => {
    for (const [write, reads] of contract) {
      const touched = invalidatesFor(write, params);
      for (const read of reads) {
        const tags = tagsFor(read, params);
        expect(
          tags.some((t) => touched.includes(t)),
          `${write} must refresh ${read}`,
        ).toBe(true);
      }
    }
  });

  it("every read carries a tag so it can be refreshed", () => {
    const reads: RpcMethod[] = [
      "system.info",
      "agents.models",
      "projects.list",
      "projects.get",
      "projects.checkoutBranch",
      "tasks.list",
      "tasks.get",
      "runs.listForTask",
      "review.diff",
      "review.snapshots",
      "git.log",
      "inbox.list",
      "review.comments.list",
      "workspace.usage",
      "memory.list",
      "memory.search",
      "memory.forTask",
      "memory.settings.get",
      "threads.list",
      "threads.get",
      "threads.lastMessage",
      "runs.listForThread",
      "threads.search",
      "threads.checkpoints",
      "threads.importable",
      "review.threadDiff",
      "git.threadLog",
      "git.threadPushState",
      "git.projectLog",
      "git.projectPushState",
      ...fileReads,
      "app.settings.get",
      "schedules.list",
      "pulls.list",
      "pulls.branches",
      "pulls.get",
      "pulls.diff",
      "pulls.review.get",
      "remote.status",
      "devices.status",
      "devices.list",
      "skills.list",
      "skills.files",
      "skills.readFile",
    ];
    for (const read of reads) expect(tagsFor(read, params).length, `${read} has no tag`).toBeGreaterThan(0);
  });

  it("refreshes a thread's change list and file diffs with its full diff, and gh with the system", () => {
    const diff = tagsFor("review.threadDiff", { threadId: "t1" }).sort();
    expect(tagsFor("review.threadChanges", { threadId: "t1", comparison: "head" }).sort()).toEqual(diff);
    expect(tagsFor("review.threadFileDiff", { threadId: "t1", path: "src/app.ts" as FolderPath }).sort()).toEqual(diff);
    expect(tagsFor("system.gh", {})).toEqual(["system"]);
    for (const write of ["review.commitThread", "review.pushThread", "review.createThreadPr"] as const) {
      expect(invalidatesFor(write, { threadId: "t1" } as never), write).toEqual(expect.arrayContaining([`threaddiff:t1`]));
    }
  });

  it("rereads a thread's Preview when the Mac opens, closes or switches its page, or the thread changes", () => {
    expect(tagsFor("preview.state", { threadId: "t1" }).sort()).toEqual(["preview", "preview:t1", "thread:t1"]);
  });

  it("rereads a phone's plan limits when usage, accounts or CLIs change, but not for a palette changed on the Mac", () => {
    expect(tagsFor("providers.limits", {}).sort()).toEqual(["claude-accounts", "provider-usage", "system"]);
  });

  it("refreshes an open file when an agent changes its conversation's folder, and on the workspace refresh", () => {
    expect(tagsFor("files.read", { scope: { kind: "thread", id: "t1" }, path: "src/app.ts" }).sort()).toEqual(["threaddiff:t1", "workspace-diff"]);
    expect(tagsFor("files.read", { scope: { kind: "task", id: "k1" }, path: "src/app.ts" }).sort()).toEqual(["diff:k1", "workspace-diff"]);
  });

  it("refreshes the checkout branch on the workspace refresh used by focus and terminal commands", async () => {
    let branch = "prod";
    const observer = new QueryObserver(queryClient, {
      queryKey: ["projects.checkoutBranch", { id: "p1" }],
      meta: { tags: tagsFor("projects.checkoutBranch", { id: "p1" }) },
      queryFn: async () => branch,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe("prod"));
      branch = "hotfix";
      invalidateTags(["workspace-diff"], { immediate: true });
      await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe("hotfix"));
    } finally {
      unsubscribe();
    }
  });

  // Diffs are not polled, so a refresh pushed while a slow read is loading must still produce a read that starts after it.
  it("lets a loading read finish and reads it once more when a pushed refresh arrives meanwhile", async () => {
    let release!: () => void;
    const reads: number[] = [];
    const observer = new QueryObserver(queryClient, {
      queryKey: ["review.threadDiff", { threadId: "slow" }],
      meta: { tags: ["threaddiff:slow"] },
      queryFn: () => {
        reads.push(reads.length + 1);
        return reads.length === 1 ? new Promise<number>((resolve) => (release = () => resolve(1))) : Promise.resolve(reads.length);
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(reads).toEqual([1]));
      invalidateTags(["threaddiff:slow"]);
      invalidateTags(["threaddiff:slow"]);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(reads).toEqual([1]);
      release();
      await vi.waitFor(() => expect(reads).toEqual([1, 2]));
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(reads).toEqual([1, 2]);
    } finally {
      unsubscribe();
    }
  });
});

it("refreshes catalogs and agent availability when the enabled selection changes", () => {
  const changed = invalidatesFor("app.settings.set", { enabledHarnesses: ["claude"] });
  for (const method of ["app.settings.get", "agents.models", "agents.modelCatalog", "agents.availability", "connectors.list", "cloud.signIns"] as const) {
    expect(tagsFor(method, {}).some((tag) => changed.includes(tag))).toBe(true);
  }
  expect(invalidatesFor("app.settings.set", { sound: true })).toEqual(["settings"]);
});
