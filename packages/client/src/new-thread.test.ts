import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEAM_LIMITS,
  executionMode,
  harnessAvailability,
  harnessIds,
  WORKSPACE_ID,
  type AppSettings,
  type HarnessId,
  type ModelOption,
  type Project,
  type RpcParams,
  type SystemInfo,
  type TeamRevision,
} from "@openorc/protocol";
import { decodeNewThreadDraft, newThreadChoice, newThreadStartInput, newThreadWorkspaceMode, targetModel } from "./new-thread.js";

const option = (agent: ModelOption["agent"], id: string, extra: Partial<ModelOption> = {}): ModelOption => ({
  id,
  label: id,
  agent,
  isDefault: false,
  efforts: ["low", "medium", "high"],
  defaultEffort: "medium",
  ...extra,
});

const catalogs = {
  full: [
    option("codex", "gpt-old", { isDefault: true, legacy: true }),
    option("codex", "gpt-mini"),
    option("codex", "gpt-main", { isDefault: true, defaultEffort: "high", fastMode: { supported: true } }),
    option("claude", "sonnet"),
    option("claude", "opus", { isDefault: true, efforts: ["low", "medium", "high", "max"], defaultEffort: "high" }),
    option("opencode", "kimi", { isDefault: true, efforts: [], defaultEffort: null }),
  ],
  codexDefaultBlocked: [
    option("codex", "gpt-main", { isDefault: true, unavailable: "Update Codex to use this model." }),
    option("codex", "gpt-mini"),
    option("claude", "opus", { isDefault: true, defaultEffort: "high" }),
  ],
  claudeOnly: [option("claude", "sonnet"), option("claude", "opus", { isDefault: true, defaultEffort: "high" })],
  empty: [],
} satisfies Record<string, ModelOption[]>;

const project = (id: string, rootPath: string): Project => ({
  id,
  name: id,
  rootPath,
  gitRemote: null,
  defaultBranch: "main",
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc/", detectedConfigs: [] },
  createdAt: 1,
  updatedAt: 1,
});

/**
 * Workspace, a repository, one before its first commit, a plain folder, and a project whose git state is still loading.
 * `canBranch` is what both apps read from `projects.git`.
 */
const projects: Record<string, { project: Project; canBranch: boolean }> = {
  workspace: { project: project(WORKSPACE_ID, "/Users/me"), canBranch: false },
  repo: { project: project("p-repo", "/code/repo"), canBranch: true },
  noCommits: { project: project("p-new", "/code/new"), canBranch: false },
  folder: { project: project("p-folder", "/code/folder"), canBranch: false },
  checking: { project: project("p-checking", "/code/checking"), canBranch: true },
};

const revision: TeamRevision = {
  id: "revision-1",
  teamId: "team-1",
  projectId: "p-repo",
  number: 1,
  name: "Team",
  createdAt: 1,
  limits: { ...DEFAULT_TEAM_LIMITS },
  members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Lead", settings: { agent: "claude", model: "opus", effort: "max", fastMode: false } }],
};

type Settings = Pick<AppSettings, "defaultWorkspaceMode" | "defaultPermissionMode">;

interface Row {
  name: string;
  project: keyof typeof projects;
  models: keyof typeof catalogs;
  /** Harnesses signed in on the Mac, and the core's default harness, chosen at onboarding. */
  signedIn: HarnessId[];
  preferred?: HarnessId;
  /** App settings, absent while they load. */
  settings?: Settings;
  /** The project's saved new-thread draft, as storage holds it. */
  saved?: unknown;
  text?: string;
  attachments?: string[];
}

const both: HarnessId[] = ["codex", "claude"];
const worktree: Settings = { defaultWorkspaceMode: "worktree", defaultPermissionMode: "review" };
const local: Settings = { defaultWorkspaceMode: "current", defaultPermissionMode: "trusted" };

const rows: (Row & { expected: Record<string, unknown> })[] = [
  {
    name: "first signed-in harness's default model and effort",
    project: "repo",
    models: "full",
    signedIn: both,
    settings: local,
    expected: { agent: "codex", model: "gpt-main", effort: "high", fastMode: false, mode: "act", permissionMode: "trusted", execution: "trusted", workspaceMode: "current" },
  },
  {
    name: "the harness chosen at onboarding",
    project: "repo",
    models: "full",
    signedIn: both,
    preferred: "claude",
    settings: local,
    expected: { agent: "claude", model: "opus", effort: "high", fastMode: false, mode: "act", permissionMode: "trusted", execution: "trusted", workspaceMode: "current" },
  },
  {
    name: "an onboarding choice that is signed out",
    project: "repo",
    models: "full",
    signedIn: ["codex"],
    preferred: "claude",
    settings: local,
    expected: { agent: "codex", model: "gpt-main", effort: "high", fastMode: false, mode: "act", permissionMode: "trusted", execution: "trusted", workspaceMode: "current" },
  },
  {
    name: "only Claude signed in",
    project: "repo",
    models: "full",
    signedIn: ["claude"],
    settings: local,
    expected: { agent: "claude", model: "opus", effort: "high", fastMode: false, mode: "act", permissionMode: "trusted", execution: "trusted", workspaceMode: "current" },
  },
  {
    name: "only Claude signed in, and Claude the default",
    project: "repo",
    models: "full",
    signedIn: ["claude"],
    preferred: "claude",
    settings: local,
    expected: { agent: "claude", model: "opus", effort: "high", fastMode: false, mode: "act", permissionMode: "trusted", execution: "trusted", workspaceMode: "current" },
  },
  {
    name: "Claude the default and every harness signed in",
    project: "repo",
    models: "full",
    signedIn: [...harnessIds],
    preferred: "claude",
    settings: worktree,
    expected: { agent: "claude", model: "opus", effort: "high", fastMode: false, mode: "act", permissionMode: "review", execution: "review", workspaceMode: "worktree" },
  },
  {
    name: "Claude the default before a first commit",
    project: "noCommits",
    models: "full",
    signedIn: both,
    preferred: "claude",
    settings: worktree,
    expected: { agent: "claude", model: "opus", effort: "high", fastMode: false, mode: "act", permissionMode: "review", execution: "review", workspaceMode: "current" },
  },
  {
    name: "Claude the default in Workspace with only Claude models",
    project: "workspace",
    models: "claudeOnly",
    signedIn: both,
    preferred: "claude",
    settings: worktree,
    expected: { agent: "claude", model: "opus", effort: "high", fastMode: false, mode: "act", permissionMode: "review", execution: "review", workspaceMode: "current" },
  },
  {
    name: "Codex the default, only Claude signed in",
    project: "checking",
    models: "full",
    signedIn: ["claude"],
    preferred: "codex",
    settings: worktree,
    expected: { agent: "claude", model: "opus", effort: "high", fastMode: false, mode: "act", permissionMode: "review", execution: "review", workspaceMode: "worktree" },
  },
  {
    name: "nothing signed in: the catalog's first default, never a legacy one",
    project: "repo",
    models: "full",
    signedIn: [],
    settings: local,
    expected: { agent: "codex", model: "gpt-main", effort: "high", fastMode: false, mode: "act", permissionMode: "trusted", execution: "trusted", workspaceMode: "current" },
  },
  {
    name: "the harness default cannot run, so another of its models",
    project: "repo",
    models: "codexDefaultBlocked",
    signedIn: both,
    settings: local,
    expected: { agent: "codex", model: "gpt-mini", effort: "medium", fastMode: false, mode: "act", permissionMode: "trusted", execution: "trusted", workspaceMode: "current" },
  },
  {
    name: "a signed-in harness with no models",
    project: "repo",
    models: "claudeOnly",
    signedIn: ["codex"],
    settings: local,
    expected: { agent: "claude", model: "opus", effort: "high", fastMode: false, mode: "act", permissionMode: "trusted", execution: "trusted", workspaceMode: "current" },
  },
  { name: "an empty catalog", project: "repo", models: "empty", signedIn: both, settings: local, expected: { error: "Choose an execution target first." } },
  {
    name: "settings still loading",
    project: "repo",
    models: "full",
    signedIn: both,
    expected: { agent: "codex", model: "gpt-main", effort: "high", fastMode: false, mode: "act", permissionMode: "trusted", execution: "trusted", workspaceMode: "current" },
  },
  {
    name: "worktree and review from settings",
    project: "repo",
    models: "full",
    signedIn: both,
    settings: worktree,
    expected: { agent: "codex", model: "gpt-main", effort: "high", fastMode: false, mode: "act", permissionMode: "review", execution: "review", workspaceMode: "worktree" },
  },
  {
    name: "autonomous from settings",
    project: "repo",
    models: "full",
    signedIn: both,
    settings: { defaultWorkspaceMode: "current", defaultPermissionMode: "autonomous" },
    expected: { agent: "codex", model: "gpt-main", effort: "high", fastMode: false, mode: "act", permissionMode: "autonomous", execution: "autonomous", workspaceMode: "current" },
  },
  {
    name: "a project before its first commit works in its folder",
    project: "noCommits",
    models: "full",
    signedIn: both,
    settings: worktree,
    expected: { agent: "codex", model: "gpt-main", effort: "high", fastMode: false, mode: "act", permissionMode: "review", execution: "review", workspaceMode: "current" },
  },
  {
    name: "a folder without git works in its folder",
    project: "folder",
    models: "full",
    signedIn: both,
    settings: worktree,
    expected: { agent: "codex", model: "gpt-main", effort: "high", fastMode: false, mode: "act", permissionMode: "review", execution: "review", workspaceMode: "current" },
  },
  {
    name: "git state still loading keeps the worktree default",
    project: "checking",
    models: "full",
    signedIn: both,
    settings: worktree,
    expected: { agent: "codex", model: "gpt-main", effort: "high", fastMode: false, mode: "act", permissionMode: "review", execution: "review", workspaceMode: "worktree" },
  },
  {
    name: "Workspace always works in its folder",
    project: "workspace",
    models: "full",
    signedIn: both,
    settings: worktree,
    expected: { agent: "codex", model: "gpt-main", effort: "high", fastMode: false, mode: "act", permissionMode: "review", execution: "review", workspaceMode: "current" },
  },
  {
    name: "a saved local choice over the worktree default",
    project: "repo",
    models: "full",
    signedIn: both,
    settings: worktree,
    saved: { workspace: "current" },
    expected: { agent: "codex", model: "gpt-main", effort: "high", fastMode: false, mode: "act", permissionMode: "review", execution: "review", workspaceMode: "current" },
  },
  {
    name: "a saved worktree choice over the local default",
    project: "repo",
    models: "full",
    signedIn: both,
    settings: local,
    saved: { workspace: "worktree" },
    expected: { agent: "codex", model: "gpt-main", effort: "high", fastMode: false, mode: "act", permissionMode: "trusted", execution: "trusted", workspaceMode: "worktree" },
  },
  {
    name: "a saved model and plan mode",
    project: "repo",
    models: "full",
    signedIn: both,
    settings: local,
    saved: { target: { kind: "model", choice: { agent: "claude", model: "sonnet", effort: "low" } }, mode: "plan" },
    expected: { agent: "claude", model: "sonnet", effort: "low", fastMode: false, mode: "plan", permissionMode: "trusted", execution: "plan", workspaceMode: "current" },
  },
  {
    name: "a saved Fast choice",
    project: "repo",
    models: "full",
    signedIn: both,
    settings: local,
    saved: { target: { kind: "model", choice: { agent: "codex", model: "gpt-main", effort: null, fastMode: true } } },
    expected: { agent: "codex", model: "gpt-main", effort: undefined, fastMode: true, mode: "act", permissionMode: "trusted", execution: "trusted", workspaceMode: "current" },
  },
  {
    name: "a saved team",
    project: "repo",
    models: "full",
    signedIn: both,
    settings: worktree,
    saved: { projectId: "p-repo", target: { kind: "team", revision, initialLeadOverrides: { effort: "high" } } },
    expected: {
      executionTarget: { kind: "team", teamRevisionId: "revision-1", initialLeadOverrides: { effort: "high" } },
      mode: "act",
      permissionMode: "review",
      execution: "review",
      workspaceMode: "worktree",
    },
  },
  {
    name: "a saved Orcling",
    project: "repo",
    models: "full",
    signedIn: both,
    settings: local,
    saved: { target: { kind: "orcling", orclingId: "orcling-1", name: "Rini", settings: { agent: "claude", model: "opus", effort: "high", fastMode: false } } },
    expected: { executionTarget: { kind: "orcling", orclingId: "orcling-1" }, mode: "act", permissionMode: "trusted", execution: "trusted", workspaceMode: "current" },
  },
  {
    name: "a saved model that cannot be restored",
    project: "repo",
    models: "full",
    signedIn: both,
    settings: local,
    saved: { target: { kind: "model", choice: { model: "missing-provider" } } },
    expected: { error: "Choose an execution target first." },
  },
  {
    name: "images without words",
    project: "repo",
    models: "full",
    signedIn: both,
    settings: local,
    text: "",
    attachments: ["/attachments/0b1c.png"],
    expected: {
      agent: "codex",
      model: "gpt-main",
      effort: "high",
      fastMode: false,
      mode: "act",
      permissionMode: "trusted",
      execution: "trusted",
      workspaceMode: "current",
      prompt: "See the attached image.",
      attachments: ["/attachments/0b1c.png"],
    },
  },
];

/** The fields a new thread's defaults decide, as `threads.start` receives them. */
function decided(params: RpcParams<"threads.start">) {
  const { agent, model, effort, fastMode, executionTarget, mode, permissionMode, workspaceMode } = params;
  return {
    agent,
    model,
    effort,
    fastMode,
    executionTarget,
    mode,
    permissionMode,
    execution: executionMode(mode, permissionMode),
    workspaceMode,
    prompt: params.prompt,
    attachments: params.attachments,
  };
}

/** The Mac's harness checks for a row, with the paths `system.info` carries. */
function systemInfo(row: Row): Pick<SystemInfo, "harnesses"> {
  return { harnesses: harnessIds.map((id) => ({ id, state: row.signedIn.includes(id) ? "ready" : "sign_in", path: `/Users/me/.local/bin/${id}`, version: "1.0.0", revision: 1 })) };
}

/** What each app reads of those checks: the desktop `system.info` itself, a phone what the core answers `agents.availability` with. */
const harnessesOf = {
  desktop: (info: Pick<SystemInfo, "harnesses">) => info.harnesses,
  phone: harnessAvailability,
};

/**
 * What a client sends for a row, composed as the desktop's New thread view and the phone's sheet compose it: the saved
 * draft, the model offered while it has none, where it works, and the permission new work starts with.
 */
function start(row: Row, app: keyof typeof harnessesOf): Record<string, unknown> {
  const { project: selected, canBranch } = projects[row.project]!;
  let draft = decodeNewThreadDraft(selected.id, row.saved ?? null);
  if (draft.target.kind === "model" && !draft.target.choice) {
    const choice = newThreadChoice(catalogs[row.models], { preferred: row.preferred ?? null, harnesses: harnessesOf[app](systemInfo(row)) });
    if (choice) draft = { ...draft, target: { kind: "model", choice } };
  }
  const workspaceMode = newThreadWorkspaceMode({ canBranch, chosen: draft.workspace, preferred: row.settings?.defaultWorkspaceMode });
  try {
    const params = newThreadStartInput(draft, {
      workspaceMode,
      permissionMode: row.settings?.defaultPermissionMode ?? "trusted",
      prompt: row.text ?? "Fix the flaky test",
      attachments: row.attachments ?? [],
    });
    return decided(params);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

describe("new thread defaults", () => {
  // The desktop rows were first checked against the desktop's own New thread code, before it moved here.
  it.each(rows)("$name, on the desktop and on a phone", ({ expected, ...row }) => {
    const sent = "error" in expected ? expected : { prompt: "Fix the flaky test", attachments: [], ...expected };
    expect(start(row, "desktop")).toEqual(sent);
    expect(start(row, "phone")).toEqual(sent);
  });

  it("shows a phone no path on the Mac", () => {
    expect(JSON.stringify(harnessAvailability(systemInfo({ name: "", project: "repo", models: "full", signedIn: both })))).not.toContain("/Users/");
  });
});

describe("new thread drafts", () => {
  it("preserves the exact saved revision and applies lead overrides without editing it", () => {
    const team = {
      ...revision,
      members: [
        ...revision.members,
        { key: "worker", name: "Worker", managerKey: "lead", responsibility: "Implement", settings: { agent: "codex" as const, model: "gpt-mini", effort: "low", fastMode: false } },
      ],
    };
    const draft = decodeNewThreadDraft("p-repo", {
      projectId: "p-repo",
      prompt: "Keep my request",
      target: { kind: "team", revision: team, initialLeadOverrides: { effort: "high", fastMode: true } },
      mode: "plan",
      workspace: "current",
    });
    expect(draft).toMatchObject({ prompt: "Keep my request", target: { kind: "team", revision: { id: "revision-1", number: 1 } }, mode: "plan", workspace: "current" });
    expect(targetModel(draft.target)).toEqual({ agent: "claude", model: "opus", effort: "high", fastMode: true });
    expect(revision.members[0]?.settings).toMatchObject({ effort: "max", fastMode: false });
  });

  it.each([
    { kind: "team", revision: { ...revision, projectId: "other-project" }, initialLeadOverrides: {} },
    { kind: "team", revision: { ...revision, members: [{}] }, initialLeadOverrides: {} },
    { kind: "model", choice: { model: "missing-provider" } },
  ])("retains the message and blocks a malformed or mismatched target instead of selecting another", (target) => {
    const draft = decodeNewThreadDraft("p-repo", { projectId: "p-repo", prompt: "Unsaved direction", target });
    expect(draft.prompt).toBe("Unsaved direction");
    expect(draft.target.kind).toBe("unavailable");
    expect(targetModel(draft.target)).toBeNull();
  });
});
