import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Db, projects, threads } from "@openorc/db";
import type { ConnectorService } from "../services/connectors.js";
import { createConnectorHandlers } from "./connectors.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function setup() {
  const db = Db.memory();
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "connectors-handler-")));
  folders.push(root);
  const project = projects.insert(db, { name: "App", rootPath: root, gitRemote: null, defaultBranch: "main", settings: {} });
  const list = vi.fn(async () => ({ connectors: [], unavailable: [], checking: false, signIn: null, signInError: null }));
  const handlers = createConnectorHandlers({ db, connectors: { list } as unknown as ConnectorService });
  const thread = (worktree: { path: string; branch: string | null }) => {
    const inserted = threads.insert(db, { projectId: project.id, title: "Review", agent: "codex", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
    return threads.update(db, inserted.id, { worktreePath: worktree.path, branch: worktree.branch });
  };
  return { handlers, list, root, thread };
}

describe("reading connectors for a conversation", () => {
  it("never reads in a copy of unvetted code, whose own servers would start, and reads the home folder instead", async () => {
    const { handlers, list, root, thread } = setup();
    const review = thread({ path: path.join(root, ".wt", "pr-12"), branch: null });
    await handlers["connectors.list"]({ scope: { kind: "thread", id: review.id } });
    expect(list).toHaveBeenLastCalledWith(undefined, undefined);
  });

  it("reads where a conversation on the user's own branch works", async () => {
    const { handlers, list, root, thread } = setup();
    const own = thread({ path: root, branch: "fix" });
    await handlers["connectors.list"]({ scope: { kind: "thread", id: own.id } });
    expect(list).toHaveBeenLastCalledWith(root, undefined);
  });
});
