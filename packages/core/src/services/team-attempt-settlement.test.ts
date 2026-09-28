import { describe, expect, it } from "vitest";
import type { TurnSettledOutcome } from "./runs.js";
import { roomDeliveryDecision } from "./team-attempt-settlement.js";

const outcome = (status: TurnSettledOutcome["status"], turnStatus?: TurnSettledOutcome["turnStatus"]): TurnSettledOutcome => ({
  status,
  snapshotId: null,
  error: null,
  ...(turnStatus === undefined ? {} : { turnStatus }),
});

describe("team room delivery settlement", () => {
  it.each([
    { closeError: null, result: outcome("error", "success"), expected: "confirmed" },
    { closeError: null, result: outcome("success", "cancelled"), expected: "cancelled" },
    { closeError: null, result: outcome("success", "error"), expected: "uncertain" },
    { closeError: "close failed", result: outcome("success", "success"), expected: "uncertain" },
    { closeError: "close failed", result: outcome("success", "cancelled"), expected: "uncertain" },
    { closeError: "close failed", result: outcome("cancelled", "success"), expected: "cancelled" },
    { closeError: null, result: outcome("success"), expected: "confirmed" },
    { closeError: null, result: outcome("cancelled"), expected: "cancelled" },
  ] as const)("keeps close, provider turn, and final status priority for $expected", ({ closeError, result, expected }) => {
    expect(roomDeliveryDecision(closeError, result)).toBe(expected);
  });
});
