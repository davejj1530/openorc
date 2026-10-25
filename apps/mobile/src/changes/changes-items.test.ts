import type { Commit, FileChangeStat, PushState, WorkspaceChanges } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { changesItems, ITEM_HEIGHTS } from "./changes-items";

const stat = (path: string): FileChangeStat => ({ path, oldPath: null, status: "modified", body: { kind: "text", insertions: 1, deletions: 0 } });
const changes = (files: FileChangeStat[], unlisted = 0): WorkspaceChanges => ({
  comparison: "head",
  baseSha: null,
  totals: { files: files.length + unlisted, insertions: files.length, deletions: 0 },
  files,
  unlisted,
});
const commit = (sha: string): Commit => ({ sha, author: "QA", at: 1, subject: `Commit ${sha}` });
const push: PushState = { branch: "feat/pairing", blocked: null, published: true, unpushedCount: 1, unpushed: ["b"], busy: false };

describe("changesItems", () => {
  it("lists the files, the count past the cap, then the branch's newest commits marking unpushed ones", () => {
    const items = changesItems(changes([stat("a.ts"), stat("b.ts")], 1204), [commit("b"), commit("a")], push);
    expect(items.map((item) => item.kind)).toEqual(["file", "file", "unlisted", "commits", "commit", "commit"]);
    expect(items[2]).toMatchObject({ kind: "unlisted", text: "1,204 more files" });
    expect(items[3]).toMatchObject({ kind: "commits", text: "Commits · feat/pairing" });
    expect(items.slice(4)).toMatchObject([{ unpushed: true }, { unpushed: false }]);
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });

  it("hides Commits while the log is empty or unread, and names one more file in the singular", () => {
    expect(changesItems(changes([stat("a.ts")], 1), [], push).map((item) => item.kind)).toEqual(["file", "unlisted"]);
    expect(changesItems(changes([stat("a.ts")], 1), undefined, undefined)[1]).toMatchObject({ text: "1 more file" });
    expect(changesItems(undefined, [commit("a")], { ...push, branch: null })).toMatchObject([{ kind: "commits", text: "Commits" }, { kind: "commit" }]);
  });

  it("gives every kind of row a fixed height", () => {
    expect(ITEM_HEIGHTS).toEqual({ file: 44, unlisted: 44, commits: 44, commit: 60 });
  });
});
