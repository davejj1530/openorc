import { getSchema } from "@tiptap/react";
import { describe, expect, it } from "vitest";
import { documentExtensions, markdownManager } from "../editor/document-schema";
import { refineDecorations } from "./refine-marks";

const schema = getSchema(documentExtensions());
const doc = (markdown: string) => schema.nodeFromJSON(markdownManager().parse(markdown));

describe("a suggestion's marks", () => {
  it("lines added blocks, fills changed words, and keeps removed text behind a toggle", () => {
    const base = doc("typing comma separated labels is annoying\n\n## Acceptance criteria\n\n- [ ] The filter survives an app restart.");
    const next = doc("## Goal\n\nAdd and remove labels one at a time.\n\n## Acceptance criteria\n\n- [ ] The filter survives quitting and reopening OpenOrc.");
    const found = refineDecorations(next, base).find();
    const of = (kind: string) => found.filter((d) => (d.spec as { kind?: string }).kind === kind);
    expect(of("added").map((d) => next.nodeAt(d.from)?.textContent)).toEqual(["Goal", "Add and remove labels one at a time."]);
    expect(of("inserted").map((d) => next.textBetween(d.from, d.to))).toEqual(["quitting and reopening OpenOrc"]);
    expect(of("removed").map((d) => d.from)).toEqual([0]);
    expect(of("deleted").map((d) => next.textBetween(d.from, d.from + 9))).toEqual(["quitting "]);
  });

  it("marks every block of a description written from nothing", () => {
    const next = doc("## Goal\n\nRetry once.");
    const found = refineDecorations(next, schema.topNodeType.createAndFill()!).find();
    expect(found).toHaveLength(2);
  });
});
