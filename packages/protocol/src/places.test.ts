import { describe, expect, it } from "vitest";
import { hostedRunId, hostedThreadOf, placeOf } from "./thread-owner.js";

describe("places", () => {
  it("answers each question for this Mac, the cloud brain and OpenOrc Cloud", () => {
    expect(placeOf({})).toEqual({ mark: null, elsewhere: false, brain: false, rowIcon: false });
    expect(placeOf({ owner: { brain: "cloud" } })).toEqual({ mark: "Cloud", elsewhere: true, brain: true, rowIcon: false });
    expect(placeOf({ owner: { brain: "hosted" } })).toEqual({ mark: "OpenOrc Cloud", elsewhere: true, brain: false, rowIcon: true });
  });

  it("reads a hosted thread off its run's id, and no thread off any other run", () => {
    expect(hostedThreadOf(hostedRunId("7f3c"))).toBe("7f3c");
    expect(hostedThreadOf("run-on-this-mac")).toBeNull();
  });
});
