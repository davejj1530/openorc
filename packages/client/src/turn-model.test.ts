import { expect, it } from "vitest";
import { turnStatusWords } from "./turn-model.js";

it("leads with where a turn stands, then how long it took", () => {
  expect(turnStatusWords({ kind: "working", elapsed: 12_000 })).toBe("Working 12s");
  expect(turnStatusWords({ kind: "working" })).toBe("Working");
  expect(turnStatusWords({ kind: "writing", elapsed: 12_000 })).toBe("Writing");
  expect(turnStatusWords({ kind: "done", elapsed: 72_000 })).toBe("Worked for 1m 12s");
  expect(turnStatusWords({ kind: "done" })).toBe("");
  expect(turnStatusWords({ kind: "failed", elapsed: 12_000 })).toBe("Failed after 12s");
  expect(turnStatusWords({ kind: "stopped" })).toBe("Stopped");
});
