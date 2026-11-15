import { expect, it } from "vitest";
import { queueHint } from "./composer-presentation.js";
import { failureParts } from "./failure-parts.js";

it("says what went wrong in a failure's first line, and keeps a daemon's log after it for when it is asked for", () => {
  expect(failureParts("Docker did not start in the sandbox.\ntime=1 level=info\nfailed to start daemon\n")).toEqual({
    headline: "Docker did not start in the sandbox.",
    details: "time=1 level=info\nfailed to start daemon",
  });
  expect(failureParts("The instance did not start.")).toEqual({ headline: "The instance did not start.", details: null });
});

it("says queued messages send when the agent finishes, unless none of them will without a retry", () => {
  expect(queueHint([{}, { interrupted: true }], "Claude")).toBe("Sends when Claude finishes");
  expect(queueHint([{ interrupted: true }], "Claude")).toBe("Didn't send");
  expect(queueHint([{ error: "You're out of cloud hours." }], "Claude")).toBe("Didn't send");
  expect(queueHint([{}], undefined)).toBe("Runs after this turn");
});
