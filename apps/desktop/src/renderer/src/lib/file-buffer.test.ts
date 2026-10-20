import { describe, expect, it } from "vitest";
import { FileVersion, FolderPath, type FileRead, type FileSnapshot, type SignedFileUrl } from "@openorc/protocol";
import { afterSave, bufferText, bufferView, draftAfterEdit, formatRequest, hasUnsavedEdits, keepMine, saveRequest, type BufferView } from "./file-buffer";
import type { Draft } from "./file-drafts";

const [v1, v2, v3] = ["1", "2", "3"].map((digit) => FileVersion.parse(digit.repeat(64))) as [FileVersion, FileVersion, FileVersion];
const path = FolderPath.parse("src/cart.ts");
const file = (version: FileVersion, text: string): FileSnapshot & { kind: "file" } => ({ kind: "file", root: "/repo", path, absolutePath: "/repo/src/cart.ts", version, text, readOnly: null });
const missing: FileRead = { kind: "missing", root: "/repo", path };
const latin1: FileRead = { kind: "unreadable", root: "/repo", path, reason: "This file is not UTF-8 text and cannot be shown." };
const binary: FileRead = {
  kind: "binary",
  root: "/repo",
  path,
  absolutePath: "/repo/src/cart.ts",
  size: 3,
  media: "other",
  mime: "application/octet-stream",
  url: "openorc-file://file/?path=x&sig=y&v=1" as SignedFileUrl,
};
const mine: Draft = { text: "mine", base: v1 };

describe("bufferView", () => {
  const cases: [string, FileRead | undefined, Draft | null | undefined, BufferView["kind"]][] = [
    ["a file not read yet", undefined, null, "loading"],
    ["a file whose draft is still loading", file(v1, "disk"), undefined, "loading"],
    ["a file without a draft", file(v1, "disk"), null, "clean"],
    ["a draft on the version on disk", file(v1, "disk"), mine, "dirty"],
    ["a draft on an older version", file(v2, "theirs"), mine, "conflict"],
    ["a draft the disk has caught up with", file(v2, "mine"), mine, "clean"],
    ["a draft on a deleted file", missing, mine, "deleted"],
    ["a deleted file without a draft", missing, null, "missing"],
    ["a draft on a file that stopped being UTF-8", latin1, mine, "unreadable"],
    ["a draft on a file that turned binary", binary, mine, "binary"],
  ];
  it.each(cases)("reads %s as the right state", (_, disk, draft, kind) => {
    expect(bufferView(disk, draft).kind).toBe(kind);
  });

  it("holds the binary file for its viewer and counts no draft on it as unsaved, so closing never asks", () => {
    const view = bufferView(binary, mine);
    expect(view).toEqual({ kind: "binary", file: binary });
    expect([hasUnsavedEdits(view), bufferText(view), saveRequest(view), formatRequest(view)]).toEqual([false, null, null, null]);
  });
});

describe("edits", () => {
  it("starts a draft on the version the editor shows", () => {
    expect(draftAfterEdit({ kind: "clean", file: file(v1, "disk") }, "disk!")).toEqual({ text: "disk!", base: v1 });
  });

  it("drops the draft when undo brings the text back to the file", () => {
    expect(draftAfterEdit({ kind: "dirty", file: file(v1, "disk"), draft: mine }, "disk")).toBeNull();
  });

  it("keeps the version a draft began on, so a disk change stays a conflict", () => {
    expect(draftAfterEdit({ kind: "conflict", file: file(v2, "theirs"), draft: mine }, "mine!")).toEqual({ text: "mine!", base: v1 });
    expect(draftAfterEdit({ kind: "deleted", path, draft: mine }, "mine!")).toEqual({ text: "mine!", base: v1 });
  });

  it("keeps mine by moving the draft onto the file as it is, which makes it saveable", () => {
    const resolved = keepMine({ kind: "conflict", file: file(v2, "theirs"), draft: mine });
    expect(saveRequest(bufferView(file(v2, "theirs"), resolved))).toEqual({ path, text: "mine", expected: { kind: "version", version: v2 } });
  });
});

describe("saveRequest", () => {
  it("expects the draft's version, recreates a deleted file only if it is still absent, and waits out a conflict", () => {
    expect(saveRequest({ kind: "dirty", file: file(v1, "disk"), draft: mine })).toEqual({ path, text: "mine", expected: { kind: "version", version: v1 } });
    expect(saveRequest({ kind: "deleted", path, draft: mine })).toEqual({ path, text: "mine", expected: { kind: "absent" } });
    expect(saveRequest({ kind: "conflict", file: file(v2, "theirs"), draft: mine })).toBeNull();
    expect(saveRequest({ kind: "clean", file: file(v1, "disk") })).toBeNull();
  });
});

describe("formatRequest", () => {
  it("formats what the editor holds, a deleted file's draft included, and leaves a read-only file alone", () => {
    expect(formatRequest({ kind: "dirty", file: file(v1, "disk"), draft: mine })).toEqual({ path, text: "mine" });
    expect(formatRequest({ kind: "clean", file: file(v1, "disk") })).toEqual({ path, text: "disk" });
    expect(formatRequest({ kind: "deleted", path, draft: mine })).toEqual({ path, text: "mine" });
    expect(formatRequest({ kind: "clean", file: { ...file(v1, "disk"), readOnly: "Pull request copies are read-only." } })).toBeNull();
    expect(formatRequest({ kind: "missing", path })).toBeNull();
  });
});

describe("afterSave", () => {
  const saved = { kind: "saved", root: "/repo", path, absolutePath: "/repo/src/cart.ts", version: v3, text: null, formatError: null } as const;

  it("makes the sent text the file and drops the draft when nothing was typed meanwhile", () => {
    expect(afterSave(saved, "mine", { kind: "dirty", file: file(v1, "disk"), draft: mine })).toEqual({ disk: file(v3, "mine"), draft: null });
  });

  it("keeps typing from during the save as a draft on the saved version", () => {
    const now: BufferView = { kind: "dirty", file: file(v1, "disk"), draft: { text: "mine, more", base: v1 } };
    expect(afterSave(saved, "mine", now)).toEqual({ disk: file(v3, "mine"), draft: { text: "mine, more", base: v3 } });
  });

  it("keeps an undo back to the old text from during the save, rather than showing the saved text over it", () => {
    expect(afterSave(saved, "mine", { kind: "clean", file: file(v1, "disk") })).toEqual({ disk: file(v3, "mine"), draft: { text: "disk", base: v3 } });
  });

  it("takes the formatted text as the file when nothing was typed during the save, and keeps typing that was", () => {
    const formatted = { ...saved, text: "MINE" };
    expect(afterSave(formatted, "mine", { kind: "dirty", file: file(v1, "disk"), draft: mine })).toEqual({ disk: file(v3, "MINE"), draft: null });
    const typing: BufferView = { kind: "dirty", file: file(v1, "disk"), draft: { text: "mine, more", base: v1 } };
    expect(afterSave(formatted, "mine", typing)).toEqual({ disk: file(v3, "MINE"), draft: { text: "mine, more", base: v3 } });
  });

  it("shows the file as it is now on a conflict and keeps the draft for the banner", () => {
    const now: BufferView = { kind: "dirty", file: file(v1, "disk"), draft: mine };
    expect(afterSave({ kind: "conflict", current: file(v2, "theirs") }, "mine", now)).toEqual({ disk: file(v2, "theirs"), draft: mine });
  });
});
