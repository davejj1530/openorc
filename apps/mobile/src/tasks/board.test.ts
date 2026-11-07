import type { BoardTask, TaskBoard } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { boardSections, taskThread, type BoardHost } from "./board";

const task = (id: string, extra: Partial<BoardTask> = {}): BoardTask => ({
  id,
  projectId: "p",
  title: id,
  status: "backlog",
  priority: "none",
  threadId: null,
  executionThreadId: null,
  updatedAt: 1,
  ...extra,
});
const board = (tasks: BoardTask[], mac: TaskBoard["mac"] = null): TaskBoard => ({ tasks, mac });
const mac = (live: boolean, answer?: TaskBoard, heardAt = 0): BoardHost => ({ host: null, kind: "mac", name: "Studio", live, board: answer, heardAt });
const brain = (answer?: TaskBoard): BoardHost => ({ host: "brain-key", kind: "brain", name: "Cloud", live: true, board: answer, heardAt: 0 });

describe("the phone's task list", () => {
  it("lists the Mac's own tasks while it answers, then the brain's, and leaves the brain's copy aside", () => {
    const sections = boardSections([mac(true, board([task("on-mac")])), brain(board([task("in-cloud")], { at: 5, tasks: [task("stale-copy")] }))]);
    expect(sections.map((section) => [section.title, section.host, section.tasks.map((each) => each.id), section.copy])).toEqual([
      ["Studio", null, ["on-mac"], null],
      ["Cloud", "brain-key", ["in-cloud"], null],
    ]);
  });

  it("shows the brain's copy of the Mac's list, read-only with its age and its projects in the cloud only, while the Mac sleeps", () => {
    const sections = boardSections([mac(false, board([task("old-answer")]), 4), brain(board([task("in-cloud")], { at: 5, tasks: [task("copied")] }))]);
    expect(sections.map((section) => [section.title, section.namesOn, section.tasks.map((each) => each.id), section.copy])).toEqual([
      ["Studio", "brain-key", ["copied"], { at: 5, cloudOnly: true }],
      ["Cloud", "brain-key", ["in-cloud"], null],
    ]);
  });

  it("shows the list the phone last heard from the Mac itself while it is newer than the brain's copy, every project in it", () => {
    const sections = boardSections([mac(false, board([task("heard")]), 9), brain(board([], { at: 5, tasks: [task("copied")] }))]);
    expect(sections.map((section) => [section.key, section.namesOn, section.tasks.map((each) => each.id), section.copy])).toEqual([
      ["mac-copy", null, ["heard"], { at: 9, cloudOnly: false }],
      ["brain:brain-key", "brain-key", [], null],
    ]);
    // No brain at all: the Mac's last list still shows, dimmed with its age.
    expect(boardSections([mac(false, board([task("heard")]), 9)]).map((section) => section.copy)).toEqual([{ at: 9, cloudOnly: false }]);
  });

  it("adds nothing for a host that never answered, as one from before task lists", () => {
    expect(boardSections([mac(true), brain()])).toEqual([]);
  });

  it("opens the conversation doing a task's work, else the one that made it", () => {
    expect(taskThread(task("t", { threadId: "maker", executionThreadId: "worker" }))).toBe("worker");
    expect(taskThread(task("t", { threadId: "maker" }))).toBe("maker");
    expect(taskThread(task("t"))).toBeNull();
  });
});
