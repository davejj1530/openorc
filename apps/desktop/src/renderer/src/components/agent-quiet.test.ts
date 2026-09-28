import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "@openorc/protocol";
import { agentQuiet, formatQuiet, QUIET_EMPHASIS_MS, QUIET_FLOOR_MS } from "./agent-quiet";

const NOW = 1_000_000_000;
const thread = (activity: ThreadSummary["activity"], lastAgentEventAt: number | null) => ({ id: "t", title: "t", activity, lastAgentEventAt }) as unknown as ThreadSummary;
const quietFor = (ms: number) => agentQuiet(thread("running", NOW - ms), NOW);

describe("agentQuiet", () => {
  it("keeps the activity guard ahead of the floor, above and below it", () => {
    // Neither of these may report, and for different reasons: the guard must be
    // doing the work above the floor, not the floor doing it by accident.
    expect(agentQuiet(thread("idle", NOW - 30_000), NOW)).toBeNull();
    expect(agentQuiet(thread("idle", NOW - 30 * 60_000), NOW)).toBeNull();
  });

  it("says nothing when a running thread has no timestamp to judge", () => {
    expect(agentQuiet(thread("running", null), NOW)).toBeNull();
  });

  it("appears exactly at the floor and not one millisecond before", () => {
    expect(quietFor(QUIET_FLOOR_MS - 1)).toBeNull();
    expect(quietFor(QUIET_FLOOR_MS)).toEqual({ ms: QUIET_FLOOR_MS, strong: false });
  });

  it("stays quiet for one minute before it strengthens", () => {
    expect(quietFor(QUIET_EMPHASIS_MS - 1)?.strong).toBe(false);
    expect(quietFor(QUIET_EMPHASIS_MS)?.strong).toBe(true);
  });

  it("never reports a negative age when the clock disagrees", () => {
    // A future timestamp clamps to zero, which the floor then withholds.
    expect(agentQuiet(thread("running", NOW + 5_000), NOW)).toBeNull();
  });
});

describe("formatQuiet", () => {
  it("reads in whole minutes, since it is only called past the floor", () => {
    expect(formatQuiet(QUIET_FLOOR_MS)).toBe("1m");
    expect(formatQuiet(119_999)).toBe("1m");
    expect(formatQuiet(QUIET_EMPHASIS_MS)).toBe("2m");
    expect(formatQuiet(6 * 60_000)).toBe("6m");
  });
});
