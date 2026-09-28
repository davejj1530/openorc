import { normalizeModelSettings } from "@openorc/protocol";
import { LeadOverrides, ModelExecutionSettings, TeamRevision, type RpcParams, type RunMode, type WorkspaceMode } from "@openorc/protocol";
import type { ModelChoice } from "../components/ModelPicker";
import { readDraft, writeDraft } from "./drafts";

export type NewThreadTarget =
  { kind: "model"; choice: ModelChoice | null } | { kind: "team"; revision: TeamRevision; initialLeadOverrides: LeadOverrides } | { kind: "unavailable"; label: string; reason: string };

export interface NewThreadDraft {
  projectId: string;
  workingDirectory?: string;
  prompt: string;
  target: NewThreadTarget;
  mode: RunMode;
  workspace: WorkspaceMode | null;
  launchRequest: { key: string; fingerprint: string } | null;
}

const key = (projectId: string) => `newthread.${projectId}.execution`;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** The revision is a snapshot for display; the core validates its ID again before launch. */
export function decodeNewThreadDraft(projectId: string, value: unknown, legacyPrompt = ""): NewThreadDraft {
  const raw = object(value) ? value : {};
  const launchRequest =
    object(raw.launchRequest) && typeof raw.launchRequest.key === "string" && raw.launchRequest.key.length > 0 && typeof raw.launchRequest.fingerprint === "string"
      ? { key: raw.launchRequest.key, fingerprint: raw.launchRequest.fingerprint }
      : null;
  const fallback: NewThreadDraft = {
    projectId,
    ...(typeof raw.workingDirectory === "string" && raw.workingDirectory.length <= 4096 ? { workingDirectory: raw.workingDirectory } : {}),
    prompt: typeof raw.prompt === "string" ? raw.prompt : legacyPrompt,
    target: { kind: "model", choice: null },
    mode: raw.mode === "plan" ? "plan" : "act",
    workspace: raw.workspace === "current" || raw.workspace === "worktree" ? raw.workspace : null,
    launchRequest,
  };
  if (!object(raw.target)) return fallback;
  if (raw.target.kind === "team") {
    const revision = TeamRevision.safeParse(raw.target.revision);
    const overrides = LeadOverrides.safeParse(raw.target.initialLeadOverrides ?? {});
    if (revision.success && overrides.success && revision.data.projectId === projectId && raw.projectId === projectId) {
      return { ...fallback, target: { kind: "team", revision: revision.data, initialLeadOverrides: overrides.data } };
    }
    return { ...fallback, target: { kind: "unavailable", label: "Saved team", reason: "This saved team selection cannot be restored. Choose the team again; your message and images are kept." } };
  }
  if (raw.target.kind === "unavailable")
    return {
      ...fallback,
      target: {
        kind: "unavailable",
        label: typeof raw.target.label === "string" ? raw.target.label : "Saved team",
        reason: typeof raw.target.reason === "string" ? raw.target.reason : "Choose the team again to continue.",
      },
    };
  if (raw.target.kind === "model" && raw.target.choice !== null) {
    const choice = object(raw.target.choice) ? ModelExecutionSettings.safeParse({ ...raw.target.choice, fastMode: raw.target.choice.fastMode ?? false }) : null;
    if (choice?.success) return { ...fallback, target: { kind: "model", choice: normalizeModelSettings(choice.data) } };
    return { ...fallback, target: { kind: "unavailable", label: "Saved model", reason: "This saved model selection cannot be restored. Choose a model again; your message and images are kept." } };
  }
  if (raw.target.kind === "model" && raw.target.choice === null) return fallback;
  return { ...fallback, target: { kind: "unavailable", label: "Saved target", reason: "This saved selection cannot be restored. Choose a model or team again; your message and images are kept." } };
}

export function readNewThreadDraft(projectId: string): NewThreadDraft {
  let legacyPrompt = "";
  try {
    const legacy: unknown = JSON.parse(localStorage.getItem("openorc.draft.new") ?? "{}");
    if (object(legacy) && typeof legacy[projectId] === "string") legacyPrompt = legacy[projectId];
  } catch {
    /* A malformed legacy draft must not prevent choosing a target. */
  }
  return decodeNewThreadDraft(projectId, readDraft<unknown>(key(projectId), null), legacyPrompt);
}

export function writeNewThreadDraft(draft: NewThreadDraft): boolean {
  return writeDraft(key(draft.projectId), draft);
}

export function teamLaunchRequest(previous: NewThreadDraft["launchRequest"], fingerprint: string): NonNullable<NewThreadDraft["launchRequest"]> {
  return previous?.fingerprint === fingerprint ? previous : { key: crypto.randomUUID(), fingerprint };
}

export function rememberNewThreadProject(projectId: string): void {
  try {
    localStorage.setItem("openorc.newthread.project", projectId);
  } catch {
    /* The in-memory selection stays usable. */
  }
}

export function readNewThreadProject(): string | null {
  try {
    return localStorage.getItem("openorc.newthread.project");
  } catch {
    return null;
  }
}

export function targetModel(target: NewThreadTarget): ModelChoice | null {
  if (target.kind === "model") return target.choice ? normalizeModelSettings(target.choice) : null;
  if (target.kind !== "team") return null;
  const lead = target.revision.members.find((member) => member.managerKey === null);
  return lead ? normalizeModelSettings({ ...lead.settings, ...target.initialLeadOverrides }) : null;
}

export function teamDepth(revision: TeamRevision): number {
  const members = new Map(revision.members.map((member) => [member.key, member]));
  return Math.max(
    ...revision.members.map((member) => {
      const seen = new Set<string>();
      let current = member,
        depth = 1;
      while (current.managerKey) {
        if (seen.has(current.key)) return Infinity;
        seen.add(current.key);
        const manager = members.get(current.managerKey);
        if (!manager) return Infinity;
        depth += 1;
        current = manager;
      }
      return depth;
    }),
  );
}

/** Both execution targets use the workspace selected in the composer. */
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
    ...(draft.target.kind === "team"
      ? { executionTarget: { kind: "team", teamRevisionId: draft.target.revision.id, initialLeadOverrides: draft.target.initialLeadOverrides } }
      : { agent: choice.agent, model: choice.model, effort: choice.effort ?? undefined, fastMode: Boolean(choice.fastMode) }),
  };
}
