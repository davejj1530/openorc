import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moveToTrash } from "./trash";

const temporary: string[] = [];
// The Trash is found through XDG_DATA_HOME, so the one this machine has is put aside and given back.
let dataHome: string | undefined;
beforeEach(() => {
  dataHome = process.env["XDG_DATA_HOME"];
  delete process.env["XDG_DATA_HOME"];
});
afterEach(() => {
  if (dataHome === undefined) delete process.env["XDG_DATA_HOME"];
  else process.env["XDG_DATA_HOME"] = dataHome;
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A home and a project folder on one disk, as a distribution's are. */
function fixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), "openorc-wsl-trash-"));
  temporary.push(base);
  const home = path.join(base, "home");
  const project = path.join(base, "project");
  mkdirSync(home);
  mkdirSync(project);
  const trash = path.join(home, ".local", "share", "Trash");
  return { home, project, trash, options: { home, uid: 1000, now: () => new Date(2026, 10, 12, 9, 5, 7) } };
}

describe.runIf(process.platform !== "win32")("the Trash inside a distribution", () => {
  it("moves a file to the home Trash with a record of where it was", async () => {
    const { project, trash, options } = fixture();
    const file = path.join(project, "notes draft.md");
    writeFileSync(file, "kept");
    await moveToTrash(file, options);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(path.join(trash, "files", "notes draft.md"), "utf8")).toBe("kept");
    expect(readFileSync(path.join(trash, "info", "notes draft.md.trashinfo"), "utf8")).toBe(`[Trash Info]\nPath=${project}/notes%20draft.md\nDeletionDate=2026-11-12T09:05:07\n`);
  });

  it("moves a folder whole", async () => {
    const { project, trash, options } = fixture();
    const worktree = path.join(project, "worktree");
    mkdirSync(path.join(worktree, "src"), { recursive: true });
    writeFileSync(path.join(worktree, "src", "index.ts"), "export {};\n");
    await moveToTrash(worktree, options);
    expect(existsSync(worktree)).toBe(false);
    expect(readFileSync(path.join(trash, "files", "worktree", "src", "index.ts"), "utf8")).toBe("export {};\n");
  });

  it("keeps both when two things of one name are removed", async () => {
    const { project, trash, options } = fixture();
    for (const content of ["first", "second"]) {
      writeFileSync(path.join(project, "a.txt"), content);
      await moveToTrash(path.join(project, "a.txt"), options);
    }
    expect(readdirSync(path.join(trash, "files")).sort()).toEqual(["a.txt", "a.txt.2"]);
    expect(readFileSync(path.join(trash, "files", "a.txt.2"), "utf8")).toBe("second");
    expect(readdirSync(path.join(trash, "info")).sort()).toEqual(["a.txt.2.trashinfo", "a.txt.trashinfo"]);
  });

  it("moves a link as a link, even one whose target is gone", async () => {
    const { project, trash, options } = fixture();
    symlinkSync(path.join(project, "nowhere"), path.join(project, "dangling"));
    await moveToTrash(path.join(project, "dangling"), options);
    expect(lstatSync(path.join(trash, "files", "dangling")).isSymbolicLink()).toBe(true);
    expect(readdirSync(project)).toEqual([]);
  });

  it("honours XDG_DATA_HOME", async () => {
    const { home, project, options } = fixture();
    process.env["XDG_DATA_HOME"] = path.join(home, "data");
    writeFileSync(path.join(project, "a.txt"), "x");
    await moveToTrash(path.join(project, "a.txt"), options);
    expect(existsSync(path.join(home, "data", "Trash", "files", "a.txt"))).toBe(true);
  });

  it("deletes nothing and leaves no record when the item cannot be moved", async () => {
    const { project, trash, options } = fixture();
    await expect(moveToTrash(path.join(project, "gone.txt"), options)).rejects.toThrow();
    expect(existsSync(path.join(trash, "info", "gone.txt.trashinfo"))).toBe(false);
    await expect(moveToTrash("relative/path.txt", options)).rejects.toThrow("Only a full path");
  });
});
