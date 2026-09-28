import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TEAM_LIMITS, type Project, type RpcResults, type TeamRevision } from "@openorc/protocol";
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
const revision: TeamRevision = {
  id: "revision-1",
  teamId: "team-1",
  projectId: project.id,
  number: 1,
  name: "Team",
  createdAt: 1,
  limits: { ...DEFAULT_TEAM_LIMITS },
  members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Lead", settings: { agent: "codex", model: "codex-model", effort: "medium", fastMode: false } }],
};

afterEach(() => vi.unstubAllGlobals());

function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
}

describe("new thread startup", () => {
  it("preserves a later prompt and images while clearing only accepted attachments", async () => {
    storage();
    const draft = { ...readNewThreadDraft(project.id), prompt: "First prompt", target: { kind: "model" as const, choice: revision.members[0]!.settings } };
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
      onPendingDraft: vi.fn(),
    });
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ projectId: project.id, prompt: "First prompt", attachments: ["/first.png"] }));
    writeNewThreadDraft({ ...draft, prompt: "Later prompt" });
    writeDraft(attachmentKey, { attachments: [{ path: "/first.png" }, { path: "/later.png" }] });
    finish({ thread: { id: "thread-1" } } as RpcResults["threads.start"]);
    await expect(pending).resolves.toBe("thread-1");
    expect(readNewThreadDraft(project.id).prompt).toBe("Later prompt");
    expect(readDraft(attachmentKey, { attachments: [] as { path: string }[] }).attachments).toEqual([{ path: "/later.png" }]);
  });

  it("retains a team launch key across a failed request and a recovered retry", async () => {
    storage();
    const draft = { ...readNewThreadDraft(project.id), prompt: "Team task", target: { kind: "team" as const, revision, initialLeadOverrides: {} } };
    writeNewThreadDraft(draft);
    const launch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce({ thread: { id: "thread-2" } });
    const input = { project, isWorkspace: false, workspaceMode: "worktree" as const, permissionMode: "review" as const, text: draft.prompt, attachments: [], launch, onPendingDraft: vi.fn() };
    await expect(startNewThread({ ...input, draft })).rejects.toThrow("Offline");
    const recovered = readNewThreadDraft(project.id);
    expect(recovered.prompt).toBe("Team task");
    expect(recovered.launchRequest?.key).toBe(launch.mock.calls[0]?.[0].requestKey);
    await expect(startNewThread({ ...input, draft: recovered })).resolves.toBe("thread-2");
    expect(launch.mock.calls[1]?.[0].requestKey).toBe(launch.mock.calls[0]?.[0].requestKey);
    expect(readNewThreadDraft(project.id).launchRequest).toBeNull();
  });
});
