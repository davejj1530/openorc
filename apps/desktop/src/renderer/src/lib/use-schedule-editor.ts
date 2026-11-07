import { type RunMode, type Schedule, type WorkspaceMode } from "@openorc/protocol";
import { useEffect, useState } from "react";
import { defaultChoice, type ModelChoice } from "../components/ModelPicker";
import { usePermissionSelection, useRpc, useRpcMutation } from "./client";
import { useProjectGit } from "./project-git";
import { scheduleDraftIssue, scheduleModelTarget, scheduleTarget, scheduleTargetChoice, scheduleTargetPayload } from "./schedule-draft";

/** What the chosen project's git allows: until it can branch, a schedule works in the project folder. */
function useScheduleGit(project: string, chosen: WorkspaceMode) {
  const { cannotBranch } = useProjectGit(project);
  return { cannotBranch, workspace: cannotBranch ? ("current" as const) : chosen };
}

function useScheduleAccount(initial?: string) {
  const accounts = useRpc("claude.accounts.list", {});
  const [selected, setAccount] = useState(initial);
  return { accounts, setAccount, claudeAccountId: selected ?? accounts.data?.defaultId ?? "claude-cli" };
}

/** Owns the editable schedule, selected target and the version used for its save. */
export function useScheduleEditor(schedule: Schedule | null, latest: Schedule | undefined, projectId: string, onClose: () => void) {
  const projects = useRpc("projects.list", {});
  const { accounts, setAccount, claudeAccountId } = useScheduleAccount(schedule?.claudeAccountId);
  const models = useRpc("agents.models", { claudeAccountId }, { staleTime: 5 * 60_000 });
  const create = useRpcMutation("schedules.create");
  const update = useRpcMutation("schedules.update");
  const [project, setProject] = useState(schedule?.projectId ?? projectId);
  const [title, setTitle] = useState(schedule?.title ?? "");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [minutes, setMinutes] = useState(schedule?.everyMinutes ?? 1440);
  const [mode, setMode] = useState<RunMode>(schedule?.mode ?? "plan");
  const { permission, select: setPermission, error: permissionError, ready: permissionReady } = usePermissionSelection(schedule?.permissionMode);
  const [chosenWorkspace, setWorkspace] = useState<WorkspaceMode>(schedule?.workspaceMode ?? "worktree");
  const git = useScheduleGit(project, chosenWorkspace);
  const workspace = git.workspace;
  const [target, setTarget] = useState(() => scheduleTarget(schedule));
  const [localError, setLocalError] = useState<string | null>(null);
  const choice = scheduleTargetChoice(target);
  const usesClaude = choice?.agent === "claude";
  const accountReady = !usesClaude || Boolean(accounts.data);
  const pending = create.isPending || update.isPending;
  const conflict = Boolean(schedule && latest && latest.version !== schedule.version);
  const { projectIssue, targetIssue } = scheduleDraftIssue(
    project,
    projects.data?.map((item) => item.id),
    target,
  );
  const error = localError ?? create.error?.message ?? update.error?.message ?? permissionError;

  useEffect(() => {
    if (target.kind !== "unselected" || !models.data) return;
    const initial = defaultChoice(models.data, null);
    if (initial) setTarget(scheduleModelTarget(initial));
  }, [target.kind, models.data]);

  const chooseModel = (selected: ModelChoice) => {
    setTarget(scheduleModelTarget(selected));
    setLocalError(null);
  };
  const changeSettings = chooseModel;
  const submit = () => {
    if (pending || !accountReady || !permissionReady || projectIssue || targetIssue || !title.trim() || !prompt.trim()) return;
    setLocalError(null);
    try {
      const base = {
        claudeAccountId,
        title: title.trim(),
        prompt: prompt.trim(),
        mode,
        permissionMode: permission,
        workspaceMode: workspace,
        everyMinutes: minutes,
        ...scheduleTargetPayload(target),
      };
      if (schedule) update.mutate({ id: schedule.id, patch: { ...base, expectedVersion: schedule.version } }, { onSuccess: onClose });
      else create.mutate({ projectId: project, ...base }, { onSuccess: onClose });
    } catch (failure) {
      setLocalError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return {
    fields: { claudeAccountId, project, title, prompt, minutes, mode, permission, workspace, worktreeBlocked: git.cannotBranch },
    target: { usesClaude, selection: target, choice },
    resources: { accounts, projects, models },
    status: { pending, conflict, projectIssue, targetIssue, error, permissionReady: permissionReady && accountReady },
    actions: { setAccount, setProject, setTitle, setPrompt, setMinutes, setMode, setPermission, setWorkspace, chooseModel, changeSettings, submit },
  };
}
