import {
  harnessIds,
  harnessLoggedIn,
  ModelExecutionSettings,
  normalizeModelSettings,
  type HarnessAvailability,
  type HarnessId,
  type ModelOption,
  type RpcParams,
  type RunMode,
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
  /** An Orcling, with the model it had when chosen for display; the core starts it with its current one. */
  | { kind: "orcling"; orclingId: string; name: string; settings: ModelExecutionSettings }
  | { kind: "unavailable"; label: string; reason: string };

/** Where a new thread works: the checkout, a worktree, or a cloud sandbox mirrored by a worktree. */
export type NewThreadPlace = WorkspaceMode | "cloud";

export interface NewThreadDraft {
  claudeAccountId?: string;
  projectId: string;
  workingDirectory?: string;
  prompt: string;
  target: NewThreadTarget;
  mode: RunMode;
  workspace: NewThreadPlace | null;
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Read saved choices without silently substituting a different execution target. */
export function decodeNewThreadDraft(projectId: string, value: unknown, legacyPrompt = ""): NewThreadDraft {
  const raw = object(value) ? value : {};
  return {
    ...(typeof raw.claudeAccountId === "string" && raw.claudeAccountId.length <= 100 ? { claudeAccountId: raw.claudeAccountId } : {}),
    projectId,
    ...(typeof raw.workingDirectory === "string" && raw.workingDirectory.length <= 4096 ? { workingDirectory: raw.workingDirectory } : {}),
    prompt: typeof raw.prompt === "string" ? raw.prompt : legacyPrompt,
    target: object(raw.target) ? decodeTarget(raw.target) : { kind: "model", choice: null },
    mode: raw.mode === "plan" ? "plan" : "act",
    workspace: decodePlace(raw.workspace),
  };
}

const places: readonly NewThreadPlace[] = ["current", "worktree", "cloud"];
const decodePlace = (value: unknown): NewThreadPlace | null => places.find((place) => place === value) ?? null;

/** A saved target that no longer reads as one keeps the message and asks for the choice again. */
function decodeTarget(raw: Record<string, unknown>): NewThreadTarget {
  if (raw.kind === "team") return { kind: "unavailable", label: "Choose a model", reason: "Choose a model or an Orcling to continue. Your message and images are kept." };
  if (raw.kind === "orcling") return decodeOrclingTarget(raw);
  if (raw.kind === "model") return decodeModelTarget(raw.choice);
  if (raw.kind === "unavailable")
    return {
      kind: "unavailable",
      label: "Saved selection",
      reason: "Choose a model or an Orcling to continue.",
    };
  return { kind: "unavailable", label: "Saved target", reason: "This saved selection cannot be restored. Choose a model or an Orcling again; your message and images are kept." };
}

function decodeModelTarget(choice: unknown): NewThreadTarget {
  if (choice === null) return { kind: "model", choice: null };
  const settings = object(choice) ? ModelExecutionSettings.safeParse({ ...choice, fastMode: choice.fastMode ?? false }) : null;
  if (settings?.success) return { kind: "model", choice: normalizeModelSettings(settings.data) };
  return { kind: "unavailable", label: "Saved model", reason: "This saved model selection cannot be restored. Choose a model again; your message and images are kept." };
}

function decodeOrclingTarget(raw: Record<string, unknown>): NewThreadTarget {
  const settings = ModelExecutionSettings.safeParse(raw.settings);
  if (settings.success && typeof raw.orclingId === "string" && typeof raw.name === "string") return { kind: "orcling", orclingId: raw.orclingId, name: raw.name, settings: settings.data };
  return { kind: "unavailable", label: "Saved Orcling", reason: "This saved Orcling selection cannot be restored. Choose it again; your message and images are kept." };
}

export function targetModel(target: NewThreadTarget): ModelChoice | null {
  if (target.kind === "model") return target.choice ? normalizeModelSettings(target.choice) : null;
  if (target.kind === "orcling") return normalizeModelSettings(target.settings);
  return null;
}

/**
 * The model a new thread offers before the person picks one: the catalog's default for the core's default harness when
 * it is signed in, else for the first signed-in harness. The desktop passes the harness rows of `system.info`, a phone
 * those of `agents.availability`, the same checks without the Mac's paths.
 */
export function newThreadChoice(models: ModelOption[], input: { preferred: HarnessId | null; harnesses: readonly HarnessAvailability[] }): ModelChoice | null {
  const signedIn = [...(input.preferred ? [input.preferred] : []), ...harnessIds].find((id) => input.harnesses.some((row) => row.id === id && harnessLoggedIn(row)));
  return defaultChoice(models, signedIn ?? null);
}

/**
 * Where a new thread works. Workspace, and a project that can't branch yet, always use the folder itself. A cloud
 * choice the thread can't take, because of its target or this app, works in a worktree instead.
 */
export function newThreadWorkspaceMode(input: { canBranch: boolean; canCloud?: boolean; chosen: NewThreadPlace | null; preferred: WorkspaceMode | undefined }): NewThreadPlace {
  if (!input.canBranch) return "current";
  if (input.chosen === "cloud" && !input.canCloud) return "worktree";
  return input.chosen ?? input.preferred ?? "current";
}

/** Every execution target uses the workspace selected in the composer. Images sent without words still need a prompt. */
export function newThreadStartInput(
  draft: NewThreadDraft,
  input: Pick<RpcParams<"threads.start">, "permissionMode" | "prompt" | "attachments"> & { workspaceMode: NewThreadPlace },
): RpcParams<"threads.start"> {
  const choice = targetModel(draft.target);
  if (!choice || draft.target.kind === "unavailable") throw new Error("Choose an execution target first.");
  const { workspaceMode: place, ...rest } = input;
  return {
    projectId: draft.projectId,
    mode: draft.mode,
    ...rest,
    ...(place === "cloud" ? { workspaceMode: "worktree", cloud: true } : { workspaceMode: place }),
    prompt: input.prompt || "See the attached image.",
    ...startTarget(draft.target, choice),
    ...(draft.claudeAccountId ? { claudeAccountId: draft.claudeAccountId } : {}),
  };
}

function startTarget(target: Exclude<NewThreadTarget, { kind: "unavailable" }>, choice: ModelChoice): Partial<RpcParams<"threads.start">> {
  if (target.kind === "orcling") return { executionTarget: { kind: "orcling", orclingId: target.orclingId } };
  return { agent: choice.agent, model: choice.model, effort: choice.effort ?? undefined, fastMode: Boolean(choice.fastMode) };
}
