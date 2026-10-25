import { describe, expect, it } from "vitest";
import { createChangeDrafts } from "./drafts";

function setup(mac: string | null = "mac-1") {
  const saved = new Map<string, string>();
  const storage = { getString: (key: string) => saved.get(key), set: (key: string, value: string) => void saved.set(key, value), remove: (key: string) => saved.delete(key) };
  return { saved, drafts: createChangeDrafts(storage, () => mac) };
}

describe("change drafts", () => {
  it("keeps a commit message per Mac and thread, and forgets an empty one", () => {
    const { saved, drafts } = setup();
    drafts.setMessage("t1", "Fix pairing");
    expect(drafts.message("t1")).toBe("Fix pairing");
    expect(saved.get("commit.mac-1.t1")).toBe("Fix pairing");
    expect(drafts.message("t2")).toBe("");
    drafts.setMessage("t1", "");
    expect(saved.size).toBe(0);
  });

  it("keeps only the pull request fields the reader edited", () => {
    const { saved, drafts } = setup();
    expect(drafts.pullRequest("t1")).toEqual({});
    drafts.editPullRequest("t1", { title: "Pairing" });
    drafts.editPullRequest("t1", { base: "release" });
    expect(drafts.pullRequest("t1")).toEqual({ title: "Pairing", base: "release" });
    expect(JSON.parse(saved.get("pr.mac-1.t1")!)).toEqual({ title: "Pairing", base: "release" });
    drafts.clearPullRequest("t1");
    expect(saved.size).toBe(0);
    saved.set("pr.mac-1.t3", "{broken");
    expect(drafts.pullRequest("t3")).toEqual({});
  });

  it("remembers the side panel's tool per thread, Changes by default", () => {
    const { drafts } = setup();
    expect(drafts.panelTool("t1")).toBe("changes");
    drafts.setPanelTool("t1", "changes");
    expect(drafts.panelTool("t1")).toBe("changes");
  });
});
