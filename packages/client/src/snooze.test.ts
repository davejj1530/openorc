import { describe, expect, it } from "vitest";
import { snoozePresets, snoozePresetsChangeAt } from "./snooze.js";

/** Wednesday 21 October 2026 at the given local time. */
const wednesday = (hours: number, minutes = 0) => new Date(2026, 9, 21, hours, minutes);
const labels = (now: Date) => snoozePresets(now).map((preset) => preset.label);

describe("snooze presets", () => {
  it("offers this evening only while it is more than ten minutes ahead", () => {
    expect(labels(wednesday(14))).toEqual(["In 1 hour", "In 3 hours", "This evening", "Tomorrow morning", "Next week"]);
    expect(labels(wednesday(17, 55))).toEqual(["In 1 hour", "In 3 hours", "Tomorrow morning", "Next week"]);
  });

  it("wakes tomorrow at nine and next week on Monday at nine", () => {
    const [, , evening, tomorrow, nextWeek] = snoozePresets(wednesday(14));
    expect(new Date(evening!.until(wednesday(14)))).toEqual(new Date(2026, 9, 21, 18));
    expect(new Date(tomorrow!.until(wednesday(14)))).toEqual(new Date(2026, 9, 22, 9));
    expect(new Date(nextWeek!.until(wednesday(14)))).toEqual(new Date(2026, 9, 26, 9));
    const monday = new Date(2026, 9, 26, 8);
    expect(new Date(snoozePresets(monday).at(-1)!.until(monday))).toEqual(new Date(2026, 10, 2, 9));
  });

  it("counts each wake from when it is chosen, not from when a menu showed it", () => {
    const [inAnHour, , , tomorrow] = snoozePresets(wednesday(9));
    expect(new Date(inAnHour!.until(wednesday(12)))).toEqual(wednesday(13));
    expect(new Date(tomorrow!.until(new Date(2026, 9, 22, 0, 30)))).toEqual(new Date(2026, 9, 23, 9));
  });

  it("wakes tomorrow morning from This evening chosen once the evening is near, as a menu built at five can be tapped at half past six", () => {
    const evening = snoozePresets(wednesday(17)).find((preset) => preset.label === "This evening")!;
    expect(new Date(evening.until(wednesday(17, 30)))).toEqual(wednesday(18));
    expect(new Date(evening.until(wednesday(17, 55)))).toEqual(new Date(2026, 9, 22, 9));
    expect(new Date(evening.until(wednesday(18, 30)))).toEqual(new Date(2026, 9, 22, 9));
  });

  it("says when the presets it offers next change: as This evening leaves at ten to six, and as it comes back at midnight", () => {
    expect(new Date(snoozePresetsChangeAt(wednesday(17)))).toEqual(wednesday(17, 50));
    expect(new Date(snoozePresetsChangeAt(wednesday(18, 30)))).toEqual(new Date(2026, 9, 22, 0));
    expect(labels(wednesday(17, 49))).toContain("This evening");
    expect(labels(wednesday(17, 50))).not.toContain("This evening");
    expect(labels(new Date(2026, 9, 22, 0))).toContain("This evening");
  });
});
