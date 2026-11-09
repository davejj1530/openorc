import type { Project, RpcParams, TaskPriority, WorkspaceMode } from "@openorc/protocol";
import { useCallback, useState } from "react";
import { shownMacId, storage } from "../client";

/** A new task as the phone keeps it while it is written: what the Mac's New task asks for, without a branch. */
export interface TaskDraft {
  title: string;
  spec: string;
  projectId: string;
  priority: TaskPriority;
}

const EMPTY: TaskDraft = { title: "", spec: "", projectId: "", priority: "none" };
const PRIORITIES: readonly TaskPriority[] = ["none", "low", "medium", "high", "urgent"];
const draftKey = () => `newtask.${shownMacId() ?? "none"}`;

/** Reads a saved draft, keeping only what still reads as one. */
export function decodeTaskDraft(value: unknown): TaskDraft {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : "");
  const priority = PRIORITIES.find((each) => each === raw.priority) ?? "none";
  return { title: text("title"), spec: text("spec"), projectId: text("projectId"), priority };
}

function read(): TaskDraft {
  try {
    return decodeTaskDraft(JSON.parse(storage.getString(draftKey()) ?? "null"));
  } catch {
    return EMPTY;
  }
}

/** The task being written, kept on the phone per Mac as it changes, so leaving the screen or a refused save keeps it. */
export function useTaskDraft(): [TaskDraft, (patch: Partial<TaskDraft>) => void, () => void] {
  const [draft, setDraft] = useState(read);
  const change = useCallback((patch: Partial<TaskDraft>) => {
    const next = { ...read(), ...patch };
    storage.set(draftKey(), JSON.stringify(next));
    setDraft(next);
  }, []);
  const clear = useCallback(() => {
    storage.remove(draftKey());
    setDraft(EMPTY);
  }, []);
  return [draft, change, clear];
}

/** The project a new task goes in: the draft's while the Mac still lists it, else the Mac's first. */
export const draftProject = (draft: TaskDraft, projects: readonly Pick<Project, "id">[] | undefined): string | null =>
  (projects?.some((project) => project.id === draft.projectId) ? draft.projectId : projects?.[0]?.id) ?? null;

/**
 * The save a draft becomes, as the Mac's New task makes it: in a worktree when the Mac starts work in one by default
 * and the project can branch, otherwise in its checkout. A description of blank lines is none.
 */
export function newTaskInput(draft: TaskDraft, projectId: string, input: { canBranch: boolean; preferred: WorkspaceMode | undefined }): RpcParams<"tasks.create"> {
  return {
    projectId,
    title: draft.title.trim(),
    ...(draft.spec.trim() ? { spec: draft.spec } : {}),
    priority: draft.priority,
    useWorktree: input.canBranch && input.preferred === "worktree",
  };
}
