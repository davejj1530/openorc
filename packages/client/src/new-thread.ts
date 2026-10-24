import {
  harnessIds,
  harnessInfo,
  harnessLoggedIn,
  LeadOverrides,
  ModelExecutionSettings,
  normalizeModelSettings,
  TeamRevision,
  type HarnessId,
  type ModelOption,
  type RpcParams,
  type RunMode,
  type SystemInfo,
  type WorkspaceMode,
} from "@openorc/protocol";
import { defaultChoice, type ModelChoice } from "./model-picker-selection.js";

/*
 * What a new thread starts with on any client: the saved draft, the model offered before the person picks one, where it
 * works, and the `threads.start` call it all becomes. The desktop and the phone read these from here so both start the
 * same thread from the same choices.
 */

export type NewThreadTarget =
  | { kind: "model"; choice: ModelChoice | null }
  | { kind: "team"; revision: TeamRevision; initialLeadOverrides: LeadOverrides }
  /** An Orcling, with the model it had when chosen for display; the core starts it with its current one. */
  | { kind: "orcling"; orclingId: string; name: string; settings: ModelExecutionSettings }
  | { kind: "unavailable"; label: string; reason: string };

export interface NewThreadDraft {
  claudeAccountId?: string;
  projectId: string;
  workingDirectory?: string;
  prompt: string;
  target: NewThreadTarget;
  mode: RunMode;
  workspace: WorkspaceMode | null;
  launchRequest: { key: string; fingerprint: string } | null;
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** The revision is a snapshot for display; the core validates its ID again before launch. */
export function decodeNewThreadDraft(projectId: string, value: unknown, legacyPrompt = ""): NewThreadDraft {
  const raw = object(value) ? value : {};
  const launchRequest =
    object(raw.launchRequest) && typeof raw.launchRequest.key === "string" && raw.launchRequest.key.length > 0 && typeof raw.launchRequest.fingerprint === "string"
      ? { key: raw.launchRequest.key, fingerprint: raw.launchRequest.fingerprint }
      : null;
  return {
    ...(typeof raw.claudeAccountId === "string" && raw.claudeAccountId.length <= 100 ? { claudeAccountId: raw.claudeAccountId } : {}),
    projectId,
    ...(typeof raw.workingDirectory === "string" && raw.workingDirectory.length <= 4096 ? { workingDirectory: raw.workingDirectory } : {}),
    prompt: typeof raw.prompt === "string" ? raw.prompt : legacyPrompt,
    target: object(raw.target) ? decodeTarget(projectId, raw.projectId, raw.target) : { kind: "model", choice: null },
    mode: raw.mode === "plan" ? "plan" : "act",
    workspace: raw.workspace === "current" || raw.workspace === "worktree" ? raw.workspace : null,
    launchRequest,
  };
}

/** A saved target that no longer reads as one keeps the message and asks for the choice again. */
function decodeTarget(projectId: string, savedProjectId: unknown, raw: Record<string, unknown>): NewThreadTarget {
  if (raw.kind === "team") return decodeTeamTarget(projectId, savedProjectId, raw);
  if (raw.kind === "orcling") return decodeOrclingTarget(raw);
  if (raw.kind === "model") return decodeModelTarget(raw.choice);
  if (raw.kind === "unavailable")
    return {
      kind: "unavailable",
      label: typeof raw.label === "string" ? raw.label : "Saved team",
      reason: typeof raw.reason === "string" ? raw.reason : "Choose the team again to continue.",
    };
  return { kind: "unavailable", label: "Saved target", reason: "This saved selection cannot be restored. Choose a model or team again; your message and images are kept." };
}

function decodeModelTarget(choice: unknown): NewThreadTarget {
  if (choice === null) return { kind: "model", choice: null };
  const settings = object(choice) ? ModelExecutionSettings.safeParse({ ...choice, fastMode: choice.fastMode ?? false }) : null;
  if (settings?.success) return { kind: "model", choice: normalizeModelSettings(settings.data) };
  return { kind: "unavailable", label: "Saved model", reason: "This saved model selection cannot be restored. Choose a model again; your message and images are kept." };
}

function decodeTeamTarget(projectId: string, savedProjectId: unknown, raw: Record<string, unknown>): NewThreadTarget {
  const revision = TeamRevision.safeParse(raw.revision);
  const overrides = LeadOverrides.safeParse(raw.initialLeadOverrides ?? {});
  if (revision.success && overrides.success && revision.data.projectId === projectId && savedProjectId === projectId) {
    return { kind: "team", revision: revision.data, initialLeadOverrides: overrides.data };
  }
  return { kind: "unavailable", label: "Saved team", reason: "This saved team selection cannot be restored. Choose the team again; your message and images are kept." };
}

function decodeOrclingTarget(raw: Record<string, unknown>): NewThreadTarget {
  const settings = ModelExecutionSettings.safeParse(raw.settings);
  if (settings.success && typeof raw.orclingId === "string" && typeof raw.name === "string") return { kind: "orcling", orclingId: raw.orclingId, name: raw.name, settings: settings.data };
  return { kind: "unavailable", label: "Saved Orcling", reason: "This saved Orcling selection cannot be restored. Choose it again; your message and images are kept." };
}

export function targetModel(target: NewThreadTarget): ModelChoice | null {
  if (target.kind === "model") return target.choice ? normalizeModelSettings(target.choice) : null;
  if (target.kind === "orcling") return normalizeModelSettings(target.settings);
  if (target.kind !== "team") return null;
  const lead = target.revision.members.find((member) => member.managerKey === null);
  return lead ? normalizeModelSettings({ ...lead.settings, ...target.initialLeadOverrides }) : null;
}

/**
 * The model a new thread offers before the person picks one: the catalog's default for the harness chosen at onboarding
 * when it is signed in, else for the first signed-in harness. A client that cannot see which harnesses are signed in
 * (a phone) passes null and takes the catalog's own first default.
 */
export function newThreadChoice(models: ModelOption[], harnesses: { preferred: HarnessId | null; system: Pick<SystemInfo, "harnesses"> } | null): ModelChoice | null {
  const signedIn = harnesses ? [...(harnesses.preferred ? [harnesses.preferred] : []), ...harnessIds].find((id) => harnessLoggedIn(harnessInfo(harnesses.system, id))) : undefined;
  return defaultChoice(models, signedIn ?? null);
}

/** Where a new thread works. Workspace, and a project that can't branch yet, always use the folder itself. */
export function newThreadWorkspaceMode(input: { canBranch: boolean; chosen: WorkspaceMode | null; preferred: WorkspaceMode | undefined }): WorkspaceMode {
  if (!input.canBranch) return "current";
  return input.chosen ?? input.preferred ?? "current";
}

/** Every execution target uses the workspace selected in the composer. Images sent without words still need a prompt. */
export function newThreadStartInput(
  draft: NewThreadDraft,
  input: Pick<RpcParams<"threads.start">, "permissionMode" | "prompt" | "attachments"> & { workspaceMode: WorkspaceMode },
): RpcParams<"threads.start"> {
  const choice = targetModel(draft.target);
  if (!choice || draft.target.kind === "unavailable") throw new Error("Choose an execution target first.");
  return {
    projectId: draft.projectId,
    mode: draft.mode,
    ...input,
    prompt: input.prompt || "See the attached image.",
    ...startTarget(draft.target, choice),
    ...(draft.claudeAccountId ? { claudeAccountId: draft.claudeAccountId } : {}),
  };
}

function startTarget(target: Exclude<NewThreadTarget, { kind: "unavailable" }>, choice: ModelChoice): Partial<RpcParams<"threads.start">> {
  if (target.kind === "team") return { executionTarget: { kind: "team", teamRevisionId: target.revision.id, initialLeadOverrides: target.initialLeadOverrides } };
  if (target.kind === "orcling") return { executionTarget: { kind: "orcling", orclingId: target.orclingId } };
  return { agent: choice.agent, model: choice.model, effort: choice.effort ?? undefined, fastMode: Boolean(choice.fastMode) };
}
