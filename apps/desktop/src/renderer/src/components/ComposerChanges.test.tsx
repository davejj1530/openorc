import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project, ReviewDiff, RpcMethod, RpcParams, RpcResults, ThreadSummary } from "@openorc/protocol";
import { Composer } from "./Composer";
import { ChangesPanel } from "../panels/ChangesPanel";
import { useComposerChanges } from "../lib/composer-changes";
import { useLayout, type WorkspaceChangesTarget } from "../lib/layout";
import { core } from "../lib/rpc";
import { invalidateTags, queryClient } from "../lib/query";

vi.mock("./DiffView", () => ({ DiffView: () => <div>Diff viewer</div> }));
const project: Project = {
  id: "project",
  name: "Composer",
  rootPath: "/repo",
  gitRemote: null,
  defaultBranch: "main",
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc", detectedConfigs: [] },
  createdAt: 0,
  updatedAt: 0,
};
const thread: ThreadSummary = {
  id: "thread",
  projectId: project.id,
  title: "Composer",
  agent: "codex",
  model: null,
  effort: null,
  fastMode: false,
  mode: "plan",
  permissionMode: "review",
  workspaceMode: "worktree",
  branch: "feature/composer",
  worktreePath: "/worktree",
  baseSha: "base",
  baseBranch: null,
  pinnedAt: null,
  seenAt: null,
  doneAt: null,
  snoozedUntil: null,
  prUrl: null,
  prState: null,
  forkedFromId: null,
  forkedAtRunId: null,
  draft: "",
  importedFrom: null,
  createdAt: 0,
  updatedAt: 0,
  lastActivityAt: 0,
  archivedAt: null,
  activity: "idle",
  unread: false,
  session: { status: "idle", message: null },
  context: null,
  queued: [],
  lastAgentEventAt: null,
  taskCount: 0,
  openTaskCount: 0,
};
let dirty: boolean;
let blocked: boolean;
let failCommit: boolean;
let failRead: boolean;
const calls: { method: string; params: unknown }[] = [];
const clean: ReviewDiff = { baseSha: null, files: [], patch: "", since: null };
const binary: ReviewDiff = { ...clean, files: [{ path: "image.png", status: "untracked", oldPath: null }], patch: "Binary files differ" };

beforeEach(() => {
  dirty = true;
  blocked = false;
  failCommit = false;
  failRead = false;
  calls.length = 0;
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  useLayout.setState({ panelOpen: false, panelTab: "changes", panelThreadId: null, selectedChanges: null, workspaceChanges: null });
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    calls.push({ method, params });
    if (method === "review.threadDiff" || method === "review.projectDiff") {
      if (failRead) throw new Error("Cannot read checkout");
      return (dirty ? binary : clean) as RpcResults[M];
    }
    if (method === "review.commitThread" || method === "review.commitProject") {
      if (failCommit) throw new Error("Commit failed; retry");
      dirty = false;
      return { sha: "1234567" } as RpcResults[M];
    }
    if (method === "orchestration.runtime") {
      const action = { allowed: !blocked, reason: blocked ? "Team is working" : null };
      return { actions: { commit: action, push: action, createPr: action } } as RpcResults[M];
    }
    if (method === "system.info") return { gh: { installed: false } } as RpcResults[M];
    const result: unknown = [];
    return result as RpcResults[M];
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

function Surface({ source, team = false }: { source: WorkspaceChangesTarget; team?: boolean }) {
  const changes = useComposerChanges({ ...source, projectName: project.name, team });
  const request = useLayout((s) => s.workspaceChanges);
  const open = useLayout((s) => s.panelOpen);
  return (
    <>
      <Composer
        value="Keep my draft"
        onChange={() => {}}
        onSubmit={async () => {}}
        placeholder="Message"
        model={null}
        onModel={() => {}}
        mode="plan"
        onMode={() => {}}
        permission="review"
        onPermission={() => {}}
        location={{ label: "Local checkout", branch: "feature/composer" }}
        changes={changes}
      />
      {open && request?.kind === source.kind && request.id === source.id ? (
        <ChangesPanel project={project} thread={source.kind === "thread" ? { ...thread, id: source.id, teamInstanceId: team ? "team" : null } : undefined} />
      ) : null}
    </>
  );
}
const mount = (source: WorkspaceChangesTarget, team = false) =>
  render(
    <QueryClientProvider client={queryClient}>
      <Surface source={source} team={team} />
    </QueryClientProvider>,
  );

it.each(["project", "thread"] as const)("reviews and commits binary-only %s changes without submitting the draft", async (kind) => {
  mount({ kind, id: kind });
  fireEvent.click(await screen.findByRole("button", { name: /Review 1 changed file/ }));
  expect(useLayout.getState().workspaceChanges).toMatchObject({ kind, id: kind, comparison: "head", commit: false });
  expect(await screen.findByText("image.png")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Commit changes" }));
  const dialog = await screen.findByRole("dialog", { name: "Commit changes" });
  expect(calls.some(({ method }) => method.startsWith("review.commit"))).toBe(false);
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Add image" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Commit" }));
  await waitFor(() => expect(document.querySelector(".composer-changes")).toBeNull());
  expect(calls).toContainEqual({
    method: kind === "thread" ? "review.commitThread" : "review.commitProject",
    params: kind === "thread" ? { threadId: kind, message: "Add image" } : { projectId: kind, message: "Add image" },
  });
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" }).value).toBe("Keep my draft");
  expect(screen.getByText("feature/composer").closest(".composer-rail")).toBeTruthy();
});

it("keeps the commit message and strip on failure, then refreshes on retry", async () => {
  failCommit = true;
  mount({ kind: "thread", id: "thread" });
  fireEvent.click(await screen.findByRole("button", { name: "Commit changes" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Preserve this message" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Commit" }));
  expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "Commit failed; retry");
  expect(within(dialog).getByRole<HTMLTextAreaElement>("textbox").value).toBe("Preserve this message");
  expect(document.querySelector(".composer-changes")).toBeTruthy();
  failCommit = false;
  fireEvent.click(within(dialog).getByRole("button", { name: "Commit" }));
  await waitFor(() => expect(document.querySelector(".composer-changes")).toBeNull());
});

it("blocks team commits while leaving review available", async () => {
  blocked = true;
  mount({ kind: "thread", id: "thread" }, true);
  const commit = await screen.findByRole<HTMLButtonElement>("button", { name: "Commit changes" });
  await waitFor(() => expect(commit.disabled).toBe(true));
  fireEvent.click(commit);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Review 1 changed file/ }));
  expect(await screen.findByText("image.png")).toBeTruthy();
  expect(calls.some(({ method }) => method.startsWith("review.commit"))).toBe(false);
});

it("keeps stale changes visible with recovery and blocks committing after a refresh failure", async () => {
  mount({ kind: "thread", id: "thread" });
  await screen.findByRole("region", { name: "Uncommitted changes" });
  failRead = true;
  act(() => invalidateTags(["workspace-diff"], { immediate: true }));
  expect(await screen.findByText("Could not refresh workspace changes.")).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Commit changes" }).disabled).toBe(true);
  failRead = false;
  dirty = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(document.querySelector(".composer-changes")).toBeNull());
});

it("routes a split conversation request to its owner and replaces saved-turn selections", () => {
  useLayout.getState().openChanges({ kind: "thread", id: "other", checkpointId: "checkpoint" });
  useLayout.getState().openWorkspaceChanges({ kind: "thread", id: "thread" }, "commit");
  const request = useLayout.getState().workspaceChanges!;
  expect(useLayout.getState()).toMatchObject({ panelThreadId: "thread", selectedChanges: null, panelOpen: true, panelTab: "changes" });
  useLayout.getState().openWorkspaceChanges({ kind: "project", id: "project" });
  useLayout.getState().consumeWorkspaceCommit(request.requestId);
  expect(useLayout.getState().workspaceChanges).toMatchObject({ kind: "project", id: "project", commit: false });
});
