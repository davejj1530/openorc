import type { OnlineTaskReport } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { onlineReference, onlineTask } from "../../lib/test-fixtures/online-task";
import { TeamReports } from "./TaskReports";

const mutate = vi.fn();
let reports: OnlineTaskReport[] = [];
vi.mock("../../lib/task-online-query", () => ({
  useTaskOnlineScope: () => ({ availability: { accountId: "me", reports: true } }),
  useTaskOnlineQuery: () => ({ data: reports }),
  useTaskOnlineMutation: () => ({ mutate, isPending: false, error: null }),
}));
vi.mock("../../lib/task-list-source", () => ({ useTaskProjects: () => ({ data: [] }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const report = (id: string, patch: Partial<OnlineTaskReport> = {}): OnlineTaskReport => ({
  id,
  at: Date.now() - 60_000,
  author: { agent: "claude", place: "computer", userId: "dana", name: "Dana Lee" },
  message: "The plan is ready.",
  card: { kind: "checklist", title: "Plan", items: [{ text: "Read the header code", done: true }] },
  replies: ["Approve the plan", "Change it"],
  answer: null,
  ...patch,
});

it("shows each agent's update with whose agent it was and where, newest first, and sends the assignee's reply", () => {
  reports = [report("r1", { message: "Started.", replies: [], card: null }), report("r2", { author: { agent: "codex", place: "cloud", userId: "me", name: "Me Too" } })];
  render(<TeamReports reference={onlineReference} task={onlineTask({ assignee: { userId: "me", memberId: "m", name: "Me Too", image: null, available: true } })} />);
  const lines = screen.getAllByText(/, on /).map((each) => each.textContent);
  expect(lines).toEqual(["Codex for you, on OpenOrc Cloud", "Claude, on Dana's computer"]);
  fireEvent.click(screen.getByRole("button", { name: "Approve the plan" }));
  expect(mutate).toHaveBeenCalledWith({ spaceId: onlineReference.spaceId, id: onlineReference.id, reportId: "r2", reply: "Approve the plan" });
});

it("lets only the task's assignee answer, and says who answered", () => {
  reports = [report("r1"), report("r2", { answer: { reply: "Change it", at: Date.now(), userId: "dana", name: "Dana Lee" } })];
  render(<TeamReports reference={onlineReference} task={onlineTask({ assignee: { userId: "dana", memberId: "m", name: "Dana Lee", image: null, available: true } })} />);
  expect((screen.getByRole("button", { name: "Approve the plan" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Dana answered/)).toBeTruthy();
});
