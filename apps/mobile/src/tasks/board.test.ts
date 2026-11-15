import type { BoardTask, TaskBoard } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { boardSection, taskThread, type BoardMac } from "./board";

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
const mac = (live: boolean, answer?: TaskBoard, heardAt = 0): BoardMac => ({ name: "Studio", live, board: answer, heardAt });

describe("the phone's task list", () => {
  it("lists the Mac's own tasks while it answers", () => {
    expect(boardSection(mac(true, board([task("on-mac")]), 4))).toEqual({ key: "mac", title: "Studio", tasks: [task("on-mac")], copiedAt: null });
  });

  it("shows the list the phone last heard from the Mac, read-only with its age, while the Mac is out of reach", () => {
    expect(boardSection(mac(false, board([task("heard")]), 9))).toEqual({ key: "mac-copy", title: "Studio", tasks: [task("heard")], copiedAt: 9 });
  });

  it("shows only the Mac's own tasks from an older Mac whose answer carries another list beside them", () => {
    expect(boardSection(mac(true, board([task("on-mac")], { at: 5, tasks: [task("another-list")] })))?.tasks.map((each) => each.id)).toEqual(["on-mac"]);
  });

  it("has none for no Mac, or a Mac that never answered, as one from before task lists", () => {
    expect(boardSection(mac(true))).toBeNull();
    expect(boardSection(mac(false))).toBeNull();
    expect(boardSection(null)).toBeNull();
  });

  it("opens the conversation doing a task's work, else the one that made it", () => {
    expect(taskThread(task("t", { threadId: "maker", executionThreadId: "worker" }))).toBe("worker");
    expect(taskThread(task("t", { threadId: "maker" }))).toBe("maker");
    expect(taskThread(task("t"))).toBeNull();
  });
});
