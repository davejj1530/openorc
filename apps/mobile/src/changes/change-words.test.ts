import type { FileChangeStat, FileDiff } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { changesLine, diffLine, fileName, fileTrailing, omittedText } from "./change-words";

const file = (over: Partial<FileChangeStat>): FileChangeStat =>
  ({ path: "src/app.ts", oldPath: null, status: "modified", body: { kind: "text", insertions: 12, deletions: 3 }, ...over }) as FileChangeStat;
const diff = (over: Partial<FileDiff>): FileDiff => ({ path: "src/app.ts", oldPath: null, status: "modified", body: { kind: "text", insertions: 12, deletions: 3 }, patch: "", cut: null, ...over });

describe("change words", () => {
  it("counts files and lines on the Changes header's faint line, with the composer chip's minus", () => {
    expect(changesLine({ files: 3, insertions: 42, deletions: 7 })).toBe("3 files · +42 −7");
    expect(changesLine({ files: 1, insertions: 0, deletions: 1200 })).toBe("1 file · −1,200");
    expect(changesLine({ files: 2, insertions: 4, deletions: 0 })).toBe("2 files · +4");
    expect(changesLine({ files: 1, insertions: 0, deletions: 0 })).toBe("1 file");
    expect(changesLine({ files: 0, insertions: 0, deletions: 0 })).toBeNull();
  });

  it("ends a row with its line counts, or why it has none", () => {
    expect(fileTrailing(file({}).body)).toEqual({ kind: "stat", insertions: "+12", deletions: "−3" });
    // A zero side is left out, and an empty new file or a pure rename ends with nothing.
    expect(fileTrailing({ kind: "text", insertions: 2, deletions: 0 })).toEqual({ kind: "stat", insertions: "+2", deletions: null });
    expect(fileTrailing({ kind: "text", insertions: 0, deletions: 1 })).toEqual({ kind: "stat", insertions: null, deletions: "−1" });
    expect(fileTrailing({ kind: "text", insertions: 0, deletions: 0 })).toBeNull();
    expect(fileTrailing({ kind: "binary" })).toEqual({ kind: "word", text: "Binary" });
    expect(fileTrailing({ kind: "omitted", reason: "large", bytes: 2_500_000 })).toEqual({ kind: "word", text: "2.4 MB" });
    expect(fileTrailing({ kind: "omitted", reason: "special", bytes: null })).toBeNull();
  });

  it("names a diff by its file, under a line of its folder and counts, or what happened to it", () => {
    expect(fileName("src/lib/app.ts")).toBe("app.ts");
    expect(diffLine(diff({ path: "src/lib/app.ts" }))).toBe("src/lib · +12 −3");
    expect(diffLine(diff({ path: "README.md" }))).toBe("+12 −3");
    expect(diffLine(diff({ path: "src/a.ts", body: { kind: "text", insertions: 0, deletions: 4 } }))).toBe("src · −4");
    expect(diffLine(diff({ path: "src/a.ts", body: { kind: "text", insertions: 0, deletions: 0 } }))).toBe("src");
    expect(diffLine(diff({ status: "renamed", oldPath: "old/app.ts" }))).toBe("Renamed from old/app.ts");
    expect(diffLine(diff({ status: "untracked" }))).toBe("New file");
    expect(diffLine(diff({ status: "added" }))).toBe("New file");
    expect(diffLine(diff({ status: "deleted" }))).toBe("Deleted");
  });

  it("says why a body is not drawn", () => {
    expect(omittedText({ kind: "binary" })).toBe("Binary file");
    expect(omittedText({ kind: "omitted", reason: "large", bytes: 2_500_000 })).toBe("Too large to show (2.4 MB)");
    expect(omittedText({ kind: "omitted", reason: "large", bytes: null })).toBe("Too large to show");
    expect(omittedText({ kind: "omitted", reason: "special", bytes: null })).toBe("Not a regular file");
    expect(omittedText({ kind: "text", insertions: 1, deletions: 0 })).toBeNull();
  });
});
