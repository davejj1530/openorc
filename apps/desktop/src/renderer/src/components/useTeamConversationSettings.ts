import { useRef, useState } from "react";
import type { ModelExecutionSettings, TeamConversation, TeamInstance, TeamRetainedTaskRuntime, Thread } from "@openorc/protocol";
import type { ModelChoice } from "./ModelPicker";
import { queryClient, useRpcMutation } from "../lib/query";
import { effectiveTeamLead, effectiveTeamPolicy, type TeamLeadAcknowledgement, type TeamPolicy, type TeamPolicyAcknowledgement } from "../lib/team-settings";
import { refreshTeamPermissionReport } from "../lib/team-permission-report";
import { teamControlParams, teamRuntimeData, teamRuntimeQueryKey, teamTaskScope } from "../lib/team-control-scope";

interface TeamSettingsInput {
  thread: Pick<Thread, "id" | "mode" | "permissionMode" | "updatedAt">;
  data: { instance: Pick<TeamInstance, "leadOverrides" | "configurationVersion">; policy?: TeamConversation["policy"] };
  leadSettings: ModelExecutionSettings;
  retainedTaskId?: string;
}

/** Lead and policy writes share one save order; sending waits for its settled tail. */
export function useTeamConversationSettings({ thread, data, leadSettings, retainedTaskId }: TeamSettingsInput) {
  const configure = useRpcMutation("orchestration.configureLead");
  const updatePolicy = useRpcMutation("threads.update");
  const [acknowledgedLead, setAcknowledgedLead] = useState<TeamLeadAcknowledgement | null>(null);
  const [acknowledgedPolicy, setAcknowledgedPolicy] = useState<TeamPolicyAcknowledgement | null>(null);
  const [editingChoice, setEditingChoice] = useState<ModelChoice | null>(null);
  const [leadSaving, setLeadSaving] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<Partial<TeamPolicy> | null>(null);
  const [policySaving, setPolicySaving] = useState(false);
  const [leadError, setLeadError] = useState<string | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [reportPending, setReportPending] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const reportGeneration = useRef(0);
  const saveTail = useRef<Promise<void>>(Promise.resolve());
  const leadOperation = useRef<Promise<unknown> | null>(null);
  const policyOperation = useRef<Promise<unknown> | null>(null);
  const failures = useRef<{ lead: string | null; policy: string | null }>({ lead: null, policy: null });

  const effectiveLead: ModelChoice = effectiveTeamLead(leadSettings, data.instance, acknowledgedLead);
  const policy = { ...effectiveTeamPolicy(thread, acknowledgedPolicy), ...editingPolicy };
  // The cache receives the post-save result before a parent query render. Use
  // that report while dropping the freshness fence, not stale props.
  const permissionReport = teamRuntimeData(queryClient.getQueryData<TeamConversation | TeamRetainedTaskRuntime | null>(teamRuntimeQueryKey(thread.id, retainedTaskId)))?.policy ?? data.policy;

  const refreshReport = async (generation: number = reportGeneration.current) => {
    setReportPending(true);
    setReportError(null);
    try {
      await refreshTeamPermissionReport(queryClient, thread.id, retainedTaskId);
      if (reportGeneration.current === generation) setReportPending(false);
    } catch (failure) {
      if (reportGeneration.current === generation) setReportError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const changeLead = (choice: ModelChoice) => {
    setEditingChoice(choice);
    setLeadSaving(true);
    const operation = saveTail.current.then(() =>
      configure.mutateAsync({ ...teamControlParams(thread.id, retainedTaskId), leadOverrides: { effort: choice.effort, fastMode: Boolean(choice.fastMode) } }),
    );
    leadOperation.current = operation;
    saveTail.current = operation.then(
      () => {},
      () => {},
    );
    void operation.then(
      (result) => {
        if (leadOperation.current !== operation) return;
        setAcknowledgedLead({ configurationVersion: result.instance.configurationVersion, settings: effectiveTeamLead(leadSettings, result.instance, null) });
        failures.current.lead = null;
        setLeadError(null);
        setEditingChoice(null);
        setLeadSaving(false);
      },
      (error) => {
        if (leadOperation.current !== operation) return;
        const message = error instanceof Error ? error.message : String(error);
        failures.current.lead = message;
        setLeadError(message);
        setLeadSaving(false);
      },
    );
  };

  const changePolicy = (patch: Partial<TeamPolicy>) => {
    setEditingPolicy(patch);
    setPolicySaving(true);
    // Equal requested values after a rapid Act → Plan → Act change do not
    // prove that a cached report describes the current writer.
    const generation = ++reportGeneration.current;
    setReportPending(true);
    setReportError(null);
    // Write only the changed control; an old render must not overwrite its
    // sibling with an earlier selection.
    const operation = saveTail.current.then(() => updatePolicy.mutateAsync({ id: thread.id, ...teamTaskScope(retainedTaskId), patch }));
    policyOperation.current = operation;
    saveTail.current = operation.then(
      () => {},
      () => {},
    );
    void operation.then(
      (result) => {
        if (policyOperation.current !== operation) return;
        setAcknowledgedPolicy({ mode: result.mode, permissionMode: result.permissionMode, updatedAt: result.updatedAt });
        failures.current.policy = null;
        setPolicyError(null);
        setEditingPolicy(null);
        setPolicySaving(false);
        void refreshReport(generation);
      },
      (error) => {
        if (policyOperation.current !== operation) return;
        const message = error instanceof Error ? error.message : String(error);
        failures.current.policy = message;
        setPolicyError(message);
        setPolicySaving(false);
        setReportPending(false);
      },
    );
  };

  const waitForSaved = async () => {
    let pendingSave: Promise<void>;
    do {
      pendingSave = saveTail.current;
      await pendingSave;
    } while (pendingSave !== saveTail.current);
    const error = failures.current.lead ?? failures.current.policy;
    if (error) throw new Error(`Save or reset the selected settings before sending. ${error}`);
  };

  const resetLead = () => {
    failures.current.lead = null;
    setLeadError(null);
    setEditingChoice(null);
    configure.reset();
  };
  const resetPolicy = () => {
    failures.current.policy = null;
    setPolicyError(null);
    setEditingPolicy(null);
    updatePolicy.reset();
  };

  return {
    lead: { effective: effectiveLead, editingChoice, saving: leadSaving, error: leadError, change: changeLead, reset: resetLead },
    policy: {
      value: policy,
      editing: editingPolicy,
      saving: policySaving,
      error: policyError,
      change: changePolicy,
      reset: resetPolicy,
      report: permissionReport,
      reportPending,
      reportError,
      refreshReport,
    },
    waitForSaved,
  };
}
