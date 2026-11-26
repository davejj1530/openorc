import type { OnlineTask } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { onlineTask } from "../../lib/test-fixtures/online-task";
import { RunFact, RunHereAsk } from "./TeamRun";

vi.mock("../../lib/task-online-query", () => ({ useTaskOnlineScope: () => ({ availability: { accountId: "me" } }) }));

afterEach(cleanup);

const run = (state: NonNullable<OnlineTask["run"]>["state"], userId = "dana"): OnlineTask["run"] => ({
  id: "run-1",
  columnId: "review",
  state,
  runner: state === "held" ? null : { userId, name: "Dana Lee" },
  requestedAt: 1,
});
const words = (task: OnlineTask) => {
  render(<RunFact task={task} />);
  const text = document.body.textContent;
  cleanup();
  return text;
};

it("says on the card where its column's agent stands, by whose computer, or yours", () => {
  const at = (value: OnlineTask["run"]) => onlineTask({ columnId: "review", run: value });
  expect(words(at(run("waiting")))).toBe("Waiting for Dana's computer");
  expect(words(at(run("waiting", "me")))).toBe("Waiting for your computer");
  expect(words(at(run("running")))).toBe("Running on Dana's computer");
  expect(words(at(run("no_folder")))).toBe("Dana needs to add the project");
  expect(words(at(run("held")))).toBe("Sent here too often. Move it to start it again");
  // A run of the column the card has since left says nothing.
  expect(words(onlineTask({ columnId: "done", run: run("waiting") }))).toBe("");
});

it("asks whether to run the agent here, or only move the card", () => {
  const onRun = vi.fn(),
    onMove = vi.fn();
  render(<RunHereAsk onRun={onRun} onMove={onMove} onCancel={() => {}} />);
  expect(screen.getByText(/This task has no assignee/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Run it on my computer" }));
  fireEvent.click(screen.getByRole("button", { name: "Just move it" }));
  expect([onRun.mock.calls.length, onMove.mock.calls.length]).toEqual([1, 1]);
});
