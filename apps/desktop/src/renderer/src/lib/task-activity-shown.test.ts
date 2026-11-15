import { expect, it } from "vitest";
import type { OnlineTask } from "@openorc/protocol";
import { CARRY_ON_MS, shownTaskActivity } from "./task-activity-shown";

type Activity = NonNullable<OnlineTask["activity"]>;
const ended = 1_000_000;
const activity = (state: Activity["state"], updatedAt = ended): Activity => ({ runId: "turn", state, latestMessage: "Checking an empty log.", lastAction: null, waitingFor: null, updatedAt });

it("reads a turn that just finished as still working, since an agent often carries on in a turn of its own", () => {
  expect(shownTaskActivity(activity("completed"), ended + 2_000)).toEqual({ ...activity("completed"), state: "working" });
  expect(shownTaskActivity(activity("completed"), ended + CARRY_ON_MS - 1)?.state).toBe("working");
});

it("reads it as finished once that moment has passed, and leaves every other state as the server says", () => {
  expect(shownTaskActivity(activity("completed"), ended + CARRY_ON_MS)?.state).toBe("completed");
  for (const state of ["working", "waiting", "failed", "cancelled", "idle"] as const) expect(shownTaskActivity(activity(state), ended + 1)?.state).toBe(state);
  expect(shownTaskActivity(null, ended)).toBeNull();
});
