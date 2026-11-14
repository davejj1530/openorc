import { type Project, type RpcResults } from "@openorc/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readDraft, writeDraft } from "../lib/drafts";
import { readNewThreadDraft, writeNewThreadDraft } from "../lib/new-thread-draft";
import { startNewThread } from "./new-thread-start";

const project: Project = {
  id: "project-1",
  name: "Project",
  rootPath: "/project",
  defaultBranch: "main",
  gitRemote: null,
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc/", detectedConfigs: [] },
  createdAt: 1,
  updatedAt: 1,
};

afterEach(() => vi.unstubAllGlobals());

function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
}

describe("new thread startup", () => {
  it("preserves a later prompt and images while clearing only accepted attachments", async () => {
    storage();
    const draft = {
      ...readNewThreadDraft(project.id),
      prompt: "First prompt",
      target: { kind: "model" as const, choice: { agent: "codex" as const, model: "codex-model", effort: "medium", fastMode: false } },
    };
    writeNewThreadDraft(draft);
    const attachmentKey = `newthread.${project.id}.attachments`;
    writeDraft(attachmentKey, { attachments: [{ path: "/first.png" }] });
    let finish!: (value: RpcResults["threads.start"]) => void;
    const launch = vi.fn(() => new Promise<RpcResults["threads.start"]>((resolve) => (finish = resolve)));
    const pending = startNewThread({
      draft,
      project,
      isWorkspace: false,
      workspaceMode: "current",
      permissionMode: "review",
      text: draft.prompt,
      attachments: ["/first.png"],
      launch,
    });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ projectId: project.id, prompt: "First prompt", attachments: ["/first.png"] }));
    writeNewThreadDraft({ ...draft, prompt: "Later prompt" });
    writeDraft(attachmentKey, { attachments: [{ path: "/first.png" }, { path: "/later.png" }] });
    finish({ thread: { id: "thread-1" } } as RpcResults["threads.start"]);
    await expect(pending).resolves.toBe("thread-1");
    expect(readNewThreadDraft(project.id).prompt).toBe("Later prompt");
    expect(readDraft(attachmentKey, { attachments: [] as { path: string }[] }).attachments).toEqual([{ path: "/later.png" }]);
  });

  it("starts on OpenOrc Cloud with files under their request id, the same when sent again, and forgets it once the thread exists", async () => {
    storage();
    const draft = { ...readNewThreadDraft(project.id), target: { kind: "model" as const, choice: { agent: "claude" as const, model: "opus", effort: null, fastMode: false } } };
    const ids = ["request-1", "request-1"];
    const files = { requestId: vi.fn(async () => ids.shift()), started: vi.fn() };
    const launch = vi
      .fn()
      .mockRejectedValueOnce(new Error("OpenOrc Cloud can't be reached."))
      .mockResolvedValueOnce({ thread: { id: "thread-1" } });
    const start = () =>
      startNewThread({ draft, project, isWorkspace: false, workspaceMode: "hosted", permissionMode: "review", text: "Read these", attachments: ["/hosted/files/f1/notes.txt"], files, launch });
    await expect(start()).rejects.toThrow("OpenOrc Cloud can't be reached.");
    expect(files.started).not.toHaveBeenCalled();
    await expect(start()).resolves.toBe("thread-1");
    expect(launch.mock.calls.map(([params]) => params.requestId)).toEqual(["request-1", "request-1"]);
    expect(files.requestId).toHaveBeenCalledWith({ text: "Read these", attachments: ["/hosted/files/f1/notes.txt"], settings: { target: draft.target, mode: draft.mode, permission: "review" } });
    expect(files.started).toHaveBeenCalledOnce();
  });
});
