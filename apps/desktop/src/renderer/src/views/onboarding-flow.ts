import { useEffect, useMemo, useRef, useState } from "react";
import { harnessCatalog, harnessIds, type HarnessId, type HarnessInfo, type Project } from "@openorc/protocol";
import type { HarnessRow } from "../components/HarnessScan";
import type { OnboardingMascotMood } from "../components/OnboardingMascot";
import { readOnboardingState, writeOnboardingState, type OnboardingStep, type PersistedOnboardingState } from "../lib/onboarding";
import { queryClient, useRpc, useRpcMutation } from "../lib/query";
import { useRouter } from "../lib/router";

interface OnboardingFlowInput {
  mode: "first_run" | "recovery";
  initialStep?: OnboardingStep;
  persisted?: PersistedOnboardingState;
  onPersist?: (state: PersistedOnboardingState) => boolean;
  onComplete?: () => void;
  preview: boolean;
}

const emptyHarnesses: readonly HarnessRow[] = harnessIds.map((id) => ({ id, state: "checking", path: null, version: null, revision: 0 }));
const previewHarnesses: readonly HarnessRow[] = [
  { id: "claude", state: "ready", path: "/usr/local/bin/claude", version: "2.1.251", revision: 1 },
  { id: "codex", state: "sign_in", path: "/usr/local/bin/codex", version: "0.81.0", revision: 1 },
];

function liveRows(harnesses: readonly HarnessInfo[] | undefined, loading: boolean, failed: boolean): HarnessRow[] {
  if (loading) return [...emptyHarnesses];
  if (failed || !harnesses) return emptyHarnesses.map((row) => ({ ...row, state: "check_failed" }));
  return harnesses.map((row) => ({ ...row }));
}

function nextStep(step: OnboardingStep): OnboardingStep {
  if (step === "scan" || step === "default") return "theme";
  if (step === "theme") return "project";
  return "done";
}

function previousStep(step: OnboardingStep): OnboardingStep {
  if (step === "done") return "project";
  if (step === "project") return "theme";
  return "scan";
}

function readyDefault(rows: readonly HarnessRow[], selected: HarnessId | null): HarnessId | null {
  if (rows.length === 1) return rows[0]!.id;
  if (selected && rows.some((row) => row.id === selected)) return selected;
  return null;
}

/** Owns saved setup progress, agent discovery, preview isolation and project import. */
export function useOnboardingFlow({ mode, initialStep, persisted, onPersist, onComplete, preview }: OnboardingFlowInput) {
  const navigate = useRouter((state) => state.navigate);
  const back = useRouter((state) => state.back);
  const system = useRpc("system.info", { refresh: false });
  const rescan = useRpcMutation("system.info");
  const projects = useRpc("projects.list", {});
  const importProject = useRpcMutation("projects.import");
  const [localPersisted, setLocalPersisted] = useState(readOnboardingState);
  const state = persisted ?? localPersisted;
  const [step, setStep] = useState<OnboardingStep>(() => {
    const saved = initialStep ?? (mode === "recovery" ? "scan" : state.step);
    return saved === "default" ? "scan" : saved;
  });
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    page.current?.closest(".onboarding-scroll")?.scrollTo?.(0, 0);
    page.current?.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
  }, [step]);
  const [selectedHarness, setSelectedHarness] = useState<HarnessId | null>(state.defaultHarness);
  const [selectedHarnesses, setSelectedHarnesses] = useState<HarnessId[]>(() => [...(state.selectedHarnesses ?? [])]);
  const selectionInitialized = useRef(state.selectedHarnesses !== null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [importing, setImporting] = useState(false);
  const importInFlight = useRef(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [addedProject, setAddedProject] = useState<Project | null>(null);
  const [simulatedRows, setSimulatedRows] = useState<HarnessRow[]>(() => previewHarnesses.map((row) => ({ ...row })));
  const rows = preview ? simulatedRows : liveRows(rescan.data?.harnesses ?? system.data?.harnesses, system.isLoading, system.isError || (rescan.isError && !system.data));
  const ready = useMemo(() => rows.filter((row) => row.state === "ready"), [rows]);
  const selectedReady = useMemo(() => ready.filter((row) => selectedHarnesses.includes(row.id)), [ready, selectedHarnesses]);
  const defaultHarness = readyDefault(selectedReady, selectedHarness);
  const projectList = useMemo(() => {
    const knownProjects = preview ? [] : (projects.data ?? []);
    return addedProject && !knownProjects.some((project) => project.id === addedProject.id) ? [addedProject, ...knownProjects] : knownProjects;
  }, [preview, projects.data, addedProject]);

  useEffect(() => {
    if (selectionInitialized.current || rows.some((row) => row.state === "checking")) return;
    setSelectedHarnesses(ready.map((row) => row.id));
    selectionInitialized.current = true;
  }, [ready, rows]);

  useEffect(() => {
    if (selectedProject && projectList.some((project) => project.id === selectedProject)) return;
    setSelectedProject(projectList[0]?.id ?? null);
  }, [projectList, selectedProject]);

  const refresh = () => {
    if (preview) return;
    rescan.mutate({ refresh: true }, { onSuccess: (next) => queryClient.setQueryData(["system.info", { refresh: false }], next) });
  };
  const openSetup = (id: HarnessId) => void window.openorc.openExternal(harnessCatalog[id].setupUrl);
  const persist = (next: PersistedOnboardingState): boolean => {
    if (preview) return true;
    const stored = onPersist ? onPersist(next) : writeOnboardingState(next);
    setStorageError(!stored);
    if (stored && !onPersist) setLocalPersisted(next);
    return stored;
  };
  const toggleHarness = (id: HarnessId) => {
    const nextSelected = selectedHarnesses.includes(id) ? selectedHarnesses.filter((selected) => selected !== id) : [...selectedHarnesses, id];
    const nextSelectedReady = ready.filter((row) => nextSelected.includes(row.id));
    const nextDefault = readyDefault(nextSelectedReady, selectedHarness);
    selectionInitialized.current = true;
    setSelectedHarnesses(nextSelected);
    setSelectedHarness(nextDefault);
    persist({ ...state, selectedHarnesses: nextSelected, defaultHarness: nextDefault });
  };
  const advance = () => {
    const next = nextStep(step);
    const nextState: PersistedOnboardingState = { ...state, step: next, completedAt: step === "project" ? Date.now() : state.completedAt, selectedHarnesses, defaultHarness };
    if (preview || persist(nextState)) setStep(next);
  };
  const retreat = () => {
    const previous = previousStep(step);
    if (persist({ ...state, step: previous, selectedHarnesses, defaultHarness })) setStep(previous);
  };
  const chooseDefault = (id: HarnessId) => {
    setSelectedHarness(id);
    persist({ ...state, selectedHarnesses, defaultHarness: id });
  };
  const complete = () => {
    if (preview) {
      setStep("done");
      return;
    }
    if (!persist({ ...state, step: "done", completedAt: state.completedAt ?? Date.now(), selectedHarnesses, defaultHarness })) return;
    onComplete?.();
    if (selectedProject) navigate({ view: "newthread", projectId: selectedProject });
    else navigate({ view: "newthread" });
  };
  const completeRecovery = () => {
    if (!persist({ ...state, step: "done" })) return;
    if (onComplete) onComplete();
    else back();
  };
  const chooseRepository = async () => {
    if (importInFlight.current) return;
    importInFlight.current = true;
    setImporting(true);
    setImportError(null);
    try {
      if (preview) {
        const project: Project = {
          id: "onboarding-preview",
          name: "Example project",
          rootPath: "/Users/you/Projects/example",
          defaultBranch: "main",
          gitRemote: null,
          settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc/", detectedConfigs: [] },
          createdAt: 0,
          updatedAt: 0,
        };
        setAddedProject(project);
        setSelectedProject(project.id);
        return;
      }
      const rootPath = await window.openorc.pickDirectory();
      if (!rootPath) return;
      const project = await importProject.mutateAsync({ rootPath });
      setAddedProject(project);
      setSelectedProject(project.id);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "The folder could not be opened.");
    } finally {
      importInFlight.current = false;
      setImporting(false);
    }
  };
  const resetPreview = () => {
    setStep("scan");
    setSelectedHarness(null);
    setSelectedHarnesses([]);
    selectionInitialized.current = false;
    setSelectedProject(null);
    setAddedProject(null);
    setImportError(null);
    setSimulatedRows(previewHarnesses.map((row) => ({ ...row })));
  };
  const scanning = rows.some((row) => row.state === "checking") || (!preview && rescan.isPending);
  let scanMood: OnboardingMascotMood = "curious";
  if (scanning) scanMood = "thinking";
  else if (storageError || (!preview && rescan.isError) || ready.length === 0) scanMood = "reassuring";
  else if (mode === "recovery" || defaultHarness !== null) scanMood = "pleased";

  return {
    page,
    progress: { step, setStep, advance, retreat, complete, completeRecovery, closeRecovery: onComplete ?? back },
    agents: {
      rows,
      ready,
      selectedReady,
      selectedHarnesses,
      defaultHarness,
      toggleHarness,
      chooseDefault,
      refresh,
      openSetup,
      scanMood,
      rescanPending: rescan.isPending,
      rescanFailed: rescan.isError,
    },
    project: {
      list: projectList,
      selectedId: selectedProject,
      select: setSelectedProject,
      importing,
      error: importError,
      loading: projects.isLoading,
      loadFailed: projects.isError,
      retry: () => void projects.refetch(),
      chooseRepository,
    },
    previewControls: {
      setRowState: (id: HarnessId, state: HarnessRow["state"]) => setSimulatedRows((current) => current.map((row) => (row.id === id ? { ...row, state } : row))),
      reset: resetPreview,
    },
    storageError,
    setStorageError,
  };
}
