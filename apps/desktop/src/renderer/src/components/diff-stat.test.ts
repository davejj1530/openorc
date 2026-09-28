import { describe, expect, it } from "vitest";
import { patchStat } from "./diff-stat";

describe("patchStat", () => {
  it("counts content lines and ignores the file headers", () => {
    const patch = ["diff --git a/a.ts b/a.ts", "index 1111111..2222222 100644", "--- a/a.ts", "+++ b/a.ts", "@@ -1,3 +1,4 @@", " context", "-gone", "+added", "+added too"].join("\n");
    expect(patchStat(patch)).toEqual({ insertions: 2, deletions: 1 });
  });

  it("reports nothing for an empty patch", () => {
    expect(patchStat("")).toEqual({ insertions: 0, deletions: 0 });
  });
});
