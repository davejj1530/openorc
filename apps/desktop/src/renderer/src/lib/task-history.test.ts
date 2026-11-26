import type { OnlineTaskHistoryEntry } from "@openorc/protocol";
import { expect, it, vi } from "vitest";
import { activityWords } from "./task-history";

vi.mock("./rpc", () => ({ core: { call: vi.fn(), onPush: () => () => {}, onReady: vi.fn() } }));
const entry = (patch: Partial<OnlineTaskHistoryEntry>): OnlineTaskHistoryEntry => ({ id: "entry", kind: "edited", actor: null, at: 1, revision: 2, changes: {}, ...patch });

it("names a board move by its column, as the column was named then", () => {
  expect(activityWords(entry({ column: { before: "Build", after: "Code review" } }))).toBe("Moved to Code review");
  expect(activityWords(entry({ kind: "status_changed", changes: { status: { before: "backlog", after: "in_progress" } }, column: { before: null, after: "Build" } }))).toBe("Moved to Build");
  expect(activityWords(entry({ column: { before: "Code review", after: null } }))).toBe("Taken out of Code review");
  expect(activityWords(entry({ kind: "status_changed", changes: { status: { before: "done", after: "archived" } }, column: { before: "Done", after: null } }))).toBe("Changed status");
  expect(activityWords(entry({}))).toBe("Updated task");
});
