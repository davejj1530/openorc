import { expect, it } from "vitest";
import { startedFamily } from "./family.js";

const row = (id: string, parentId: string | null, rootId: string | null, relation: string | null) => ({ id, parentId, rootId, relation });

it("reads a thread's started family each after its parent, without its agents' helpers or another thread's", () => {
  const rows = [
    row("links", "copy", "root", "started"),
    row("helper", "root", "root", "subagent"),
    row("copy", "root", "root", "started"),
    row("root", null, null, null),
    row("theirs", "other", "other", "started"),
    row("deep", "links", "root", "started"),
  ];
  expect(startedFamily(rows, "root").map((one) => one.id)).toEqual(["copy", "links", "deep"]);
  expect(startedFamily(rows, "copy")).toEqual([]);
});
