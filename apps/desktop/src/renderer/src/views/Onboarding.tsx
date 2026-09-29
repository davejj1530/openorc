import { useState, type ReactNode } from "react";
import { harnessCatalog, type HarnessId, type Project } from "@openorc/protocol";
import { ArrowLeft, ArrowRight, Check, FolderGit2, Monitor, Moon, RotateCcw, Settings2, Sun } from "../components/icons";
import { HarnessScan, type HarnessRow, type HarnessRowState } from "../components/HarnessScan";
import { OnboardingMascot } from "../components/OnboardingMascot";
import { Button, Select, TextButton } from "../components/ui";
import { type OnboardingStep, type PersistedOnboardingState } from "../lib/onboarding";
import { useTheme, type ThemeChoice } from "../lib/theme";
import { PaletteSelector } from "../components/PaletteSelector";
import { useTrafficLights, useWindowsControls } from "../lib/window";
import { useOnboardingFlow } from "./onboarding-flow";
import "../styles/onboarding.css";

export type OnboardingMode = "first_run" | "recovery";

const previewStates: readonly HarnessRowState[] = ["checking", "ready", "sign_in", "not_found", "check_failed"];
const stepOrder: readonly OnboardingStep[] = ["scan", "theme", "project", "done"];
const progressSteps: readonly {
  id: Exclude<OnboardingStep, "done">;
  label: string;
}[] = [
  { id: "scan", label: "Agents" },
  { id: "theme", label: "Appearance" },
  { id: "project", label: "Project" },
];

/** "Codex, Claude Code and OpenCode" for any number of names. */
function readyNames(names: string[]): string {
  return names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function projectMood(importing: boolean, loading: boolean, error: boolean, selected: boolean): Parameters<typeof OnboardingMascot>[0]["mood"] {
  if (importing || loading) return "thinking";
  if (error) return "reassuring";
  return selected ? "pleased" : "curious";
}

function projectChoices(input: { projects: readonly Project[]; selectedId: string | null; loading: boolean; loadFailed: boolean; onSelect: (id: string) => void }): ReactNode {
  if (input.projects.length > 0) {
    return (
      <fieldset className="onboarding-projects">
        <legend className="onboarding-section-title">Choose a project</legend>
        <div className="onboarding-project-list">
          {input.projects.map((project) => (
            <label className="onboarding-project-row" data-selected={project.id === input.selectedId || undefined} key={project.id}>
              <input className="sr-only" type="radio" name="onboarding-project" value={project.id} checked={project.id === input.selectedId} onChange={() => input.onSelect(project.id)} />
              <FolderGit2 size={20} aria-hidden="true" />
              <span className="min-w-0">
                <span className="onboarding-project-name">{project.name}</span>
                <span className="onboarding-project-path" title={project.rootPath}>
                  {project.rootPath}
                </span>
              </span>
              <span className="harness-choice-mark" aria-hidden="true">
                {project.id === input.selectedId ? <Check size={13} /> : null}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  if (!input.loading && !input.loadFailed)
    return (
      <div className="onboarding-project-empty">
        <FolderGit2 size={28} aria-hidden="true" />
        <h2 className="onboarding-section-title">Start with a local repository</h2>
        <p className="onboarding-section-copy">Choose its folder to add it to OpenOrc. Your files stay where they are.</p>
      </div>
    );
  return null;
}

function projectImportLabel(importing: boolean, hasProjects: boolean): string {
  if (importing) return "Opening repository…";
  return hasProjects ? "Choose another repository" : "Choose repository";
}

function canContinueSetup(step: OnboardingStep, scanReady: boolean, projectReady: boolean): boolean {
  if (step === "scan") return scanReady;
  if (step === "project") return projectReady;
  return true;
}

function readyMessage(selectedReady: readonly HarnessRow[]): string {
  if (selectedReady.length > 1) return `${readyNames(selectedReady.map((row) => harnessCatalog[row.id].name))} are ready`;
  if (selectedReady[0]) return `${harnessCatalog[selectedReady[0].id].name} is ready`;
  return "Your coding agent is ready";
}

function setupActionNote(input: { step: OnboardingStep; selectedCount: number; readyCount: number; defaultHarness: HarnessId | null; preview: boolean; selectedProject: string | null }): string {
  if (input.step === "scan") {
    if (input.selectedCount === 0) return input.readyCount === 0 ? "Set up or reconnect at least one agent to continue." : "Select at least one ready agent to continue.";
    return input.defaultHarness === null ? "Choose an agent to start new threads with." : `${harnessCatalog[input.defaultHarness].name} will start your new threads.`;
  }
  if (input.step === "theme")
    return input.preview ? "Preview choices stay disposable and do not change your saved appearance." : "Looks good? Continue with these settings. You can change them later.";
  return input.selectedProject ? "Your project is selected. You’re ready to finish setup." : "Choose a repository to continue.";
}

function Progress({ step }: { step: OnboardingStep }) {
  const current = stepOrder.indexOf(step);
  return (
    <ol className="onboarding-progress" aria-label="Setup progress">
      {progressSteps.map((item, index) => (
        <li
          className="onboarding-progress-item"
          aria-current={item.id === step ? "step" : undefined}
          data-current={item.id === step || undefined}
          data-complete={index < current || undefined}
          key={item.id}
        >
          <span className="onboarding-progress-dot" aria-hidden="true">
            {index < current ? <Check size={12} /> : index + 1}
          </span>
          <span>{item.label}</span>
          {index < current ? <span className="sr-only"> completed</span> : null}
        </li>
      ))}
    </ol>
  );
}

function PreviewTools({
  step,
  rows,
  onStep,
  onState,
  onReplay,
  onReset,
}: {
  step: OnboardingStep;
  rows: readonly HarnessRow[];
  onStep: (step: OnboardingStep) => void;
  onState: (id: HarnessId, state: HarnessRowState) => void;
  onReplay: () => void;
  onReset: () => void;
}) {
  return (
    <div className="onboarding-preview" aria-label="Onboarding preview controls">
      <div className="onboarding-preview-inner">
        <span className="onboarding-preview-label">Disposable preview</span>
        <label className="onboarding-preview-field">
          Step{" "}
          <Select value={step} onChange={(event) => onStep(event.target.value as OnboardingStep)}>
            {stepOrder.map((value) => (
              <option value={value} key={value}>
                {value}
              </option>
            ))}
          </Select>
        </label>
        {rows.map((row) => (
          <label className="onboarding-preview-field" key={row.id}>
            {harnessCatalog[row.id].name}{" "}
            <Select value={row.state} onChange={(event) => onState(row.id, event.target.value as HarnessRowState)}>
              {previewStates.map((state) => (
                <option value={state} key={state}>
                  {state}
                </option>
              ))}
            </Select>
          </label>
        ))}
        <div className="onboarding-preview-actions">
          <Button size="sm" onClick={onReplay}>
            <RotateCcw size={12} /> Replay
          </Button>
          <TextButton tone="muted" onClick={onReset}>
            Reset preview
          </TextButton>
        </div>
      </div>
    </div>
  );
}

function ProjectStep({
  projects,
  selectedId,
  importing,
  loading,
  loadFailed,
  error,
  onSelect,
  onImport,
  onRetry,
}: {
  projects: readonly Project[];
  selectedId: string | null;
  importing: boolean;
  loading: boolean;
  loadFailed: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onImport: () => void;
  onRetry: () => void;
}) {
  return (
    <>
      <header className="onboarding-heading onboarding-heading-with-mascot">
        <OnboardingMascot mood={projectMood(importing, loading, Boolean(error || loadFailed), Boolean(selectedId))} reactionKey={selectedId ?? ""} />
        <h1 tabIndex={-1}>Bring in your first project</h1>
        <p>Choose a local Git repository to keep your conversations, tasks, and agent work together.</p>
      </header>
      {loading ? (
        <p className="onboarding-section-copy" role="status">
          Loading your projects…
        </p>
      ) : null}
      {loadFailed ? (
        <div className="onboarding-feedback" role="alert">
          <p>Couldn’t load your projects. Try again or choose a repository below.</p>
          <Button onClick={onRetry}>Retry loading projects</Button>
        </div>
      ) : null}
      {projectChoices({ projects, selectedId, loading, loadFailed, onSelect })}
      <div className="onboarding-import">
        <Button onClick={onImport} disabled={importing}>
          <FolderGit2 size={14} /> {projectImportLabel(importing, projects.length > 0)}
        </Button>
        <p className="onboarding-section-copy">Use the folder that contains your Git repository.</p>
      </div>
      {error ? (
        <div className="onboarding-feedback" role="alert">
          <p>Couldn’t add this repository. {error}</p>
          <p>Choose a local Git repository and try again.</p>
        </div>
      ) : null}
    </>
  );
}

const appearanceModes = [
  { id: "system", name: "System", icon: Monitor },
  { id: "light", name: "Light", icon: Sun },
  { id: "dark", name: "Dark", icon: Moon },
] satisfies { id: ThemeChoice; name: string; icon: typeof Sun }[];

function ThemeStep({ preview, onStorageError }: { preview: boolean; onStorageError: (failed: boolean) => void }) {
  const theme = useTheme();
  const [previewChoice, setPreviewChoice] = useState(theme.choice);
  const [previewPreset, setPreviewPreset] = useState(theme.preset);
  const choice = preview ? previewChoice : theme.choice;
  const preset = preview ? previewPreset : theme.preset;
  const systemMode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const resolved = choice === "system" ? systemMode : choice;
  const chooseMode = (next: ThemeChoice) => {
    if (preview) {
      setPreviewChoice(next);
      return;
    }
    onStorageError(!theme.set(next));
  };
  const choosePreset = (next: typeof theme.preset) => {
    if (preview) {
      setPreviewPreset(next);
      return;
    }
    onStorageError(!theme.setPreset(next));
  };

  return (
    <div className="onboarding-theme">
      <header className="onboarding-heading onboarding-heading-with-mascot">
        <OnboardingMascot mood="styling" reactionKey={`${choice}:${preset}`} />
        <h1 tabIndex={-1}>Choose how OpenOrc looks</h1>
        <p>Pick an appearance and palette for your workspace. You can change either later in Settings.</p>
      </header>
      <section className="onboarding-theme-section" aria-labelledby="theme-mode-title">
        <h2 className="onboarding-section-title" id="theme-mode-title">
          Appearance
        </h2>
        <div className="appearance-modes" role="group" aria-label="Color appearance">
          {appearanceModes.map(({ id, name, icon: Icon }) => (
            <button key={id} type="button" aria-pressed={choice === id} onClick={() => chooseMode(id)}>
              <Icon size={16} />
              {name}
            </button>
          ))}
        </div>
      </section>
      <section className="onboarding-theme-section" aria-labelledby="theme-palette-title">
        <h2 className="onboarding-section-title" id="theme-palette-title">
          Palette
        </h2>
        <PaletteSelector preset={preset} mode={resolved} custom={theme.custom} onChange={choosePreset} />
      </section>
    </div>
  );
}

/** The draggable header, padded clear of native window controls at either end. */
function OnboardingChrome({ children }: { children: ReactNode }) {
  const trafficLights = useTrafficLights();
  const windowsControls = useWindowsControls();
  return (
    <header className="onboarding-chrome" data-traffic-lights={trafficLights || undefined} data-window-controls={windowsControls || undefined}>
      {children}
    </header>
  );
}

interface OnboardingProps {
  mode?: OnboardingMode;
  previewInitially?: boolean;
  initialStep?: OnboardingStep;
  persisted?: PersistedOnboardingState;
  onPersist?: (state: PersistedOnboardingState) => boolean;
  onComplete?: () => void;
}

export function Onboarding(props: OnboardingProps) {
  const [preview, setPreview] = useState(import.meta.env.DEV && Boolean(props.previewInitially));
  // Remount at the preview boundary so simulated choices never become live preferences.
  return <OnboardingFlow key={String(preview)} {...props} preview={preview} onTogglePreview={() => setPreview((value) => !value)} />;
}

function OnboardingFlow({ mode = "first_run", initialStep, persisted, onPersist, onComplete, preview, onTogglePreview }: OnboardingProps & { preview: boolean; onTogglePreview: () => void }) {
  const flow = useOnboardingFlow({ mode, initialStep, persisted, onPersist, onComplete, preview });
  const { page, progress, agents, project, previewControls, storageError, setStorageError } = flow;
  const { step, setStep, advance, retreat, complete, completeRecovery, closeRecovery } = progress;
  const { rows, ready, selectedReady, selectedHarnesses, defaultHarness, toggleHarness, chooseDefault, refresh, openSetup, scanMood, rescanPending, rescanFailed } = agents;
  const {
    list: projectList,
    selectedId: selectedProject,
    select: setSelectedProject,
    importing,
    error: importError,
    loading: projectLoading,
    loadFailed: projectLoadFailed,
    retry: retryProjects,
    chooseRepository,
  } = project;

  if (mode === "recovery") {
    const canReturn = rows.some((row) => row.state === "ready");
    return (
      <div className="onboarding-root">
        <OnboardingChrome>
          <span className="onboarding-brand">OpenOrc</span>
          <span className="onboarding-chrome-label" />
          <TextButton className="onboarding-preview-trigger" tone="muted" onClick={closeRecovery}>
            Close
          </TextButton>
        </OnboardingChrome>
        <main className="onboarding-surface">
          <div className="onboarding-scroll">
            <div className="onboarding-page" ref={page}>
              <header className="onboarding-heading onboarding-heading-with-mascot">
                <OnboardingMascot mood={scanMood} />
                <h1 tabIndex={-1}>Reconnect your coding agent</h1>
                <p>Your projects and previous setup are still here. Sign in to an agent again, then rescan to start new work.</p>
              </header>
              <HarnessScan rows={rows} refreshing={rescanPending} onRefresh={refresh} onRetry={refresh} onConnect={openSetup} onSetup={openSetup} />
              {rescanFailed ? (
                <p className="onboarding-feedback" role="alert">
                  Couldn’t refresh agent status. Try Rescan again.
                </p>
              ) : null}
            </div>
          </div>
          <footer className="onboarding-actions onboarding-footer">
            <p className="onboarding-action-note">Your saved preferences will stay in place.</p>
            <div className="onboarding-action-buttons">
              <Button variant="primary" disabled={!canReturn} onClick={completeRecovery}>
                Return to OpenOrc
              </Button>
            </div>
          </footer>
          {storageError ? (
            <p className="text-sm text-bad mt-3" role="alert">
              Setup progress could not be saved. Keep this window open and try again.
            </p>
          ) : null}
        </main>
      </div>
    );
  }

  const scanCanContinue = selectedReady.length > 0 && defaultHarness !== null;
  const projectCanContinue = selectedProject !== null && !importing;
  const canContinue = canContinueSetup(step, scanCanContinue, projectCanContinue);

  return (
    <div className="onboarding-root">
      <OnboardingChrome>
        <span className="onboarding-brand">OpenOrc</span>
        <span className="onboarding-chrome-label">Set up your workspace</span>
        {import.meta.env.DEV ? (
          <TextButton className="onboarding-preview-trigger" tone="muted" onClick={onTogglePreview}>
            <Settings2 size={13} /> {preview ? "Use live state" : "Preview states"}
          </TextButton>
        ) : (
          <span />
        )}
      </OnboardingChrome>
      {preview ? <PreviewTools step={step} rows={rows} onStep={setStep} onState={previewControls.setRowState} onReplay={() => setStep("scan")} onReset={previewControls.reset} /> : null}
      <main className="onboarding-surface">
        <Progress step={step} />
        <div className="onboarding-scroll">
          <div className="onboarding-page" ref={page}>
            {step === "scan" ? (
              <>
                <header className="onboarding-heading onboarding-heading-with-mascot">
                  <OnboardingMascot mood={scanMood} reactionKey={`${selectedHarnesses.join(":")}:${defaultHarness}`} />
                  <h1 tabIndex={-1}>Use the agents you already have</h1>
                  <p>OpenOrc brings your coding agents into one workspace. Choose which agents to use; your existing sign-ins carry over.</p>
                </header>
                <HarnessScan
                  rows={rows}
                  selection={{
                    mode: "multiple",
                    selectedIds: selectedHarnesses,
                    onChange: toggleHarness,
                  }}
                  refreshing={!preview && rescanPending}
                  onRefresh={refresh}
                  onRetry={refresh}
                  onConnect={openSetup}
                  onSetup={openSetup}
                />
              </>
            ) : null}
            {step === "scan" && selectedReady.length > 1 ? (
              <div className="onboarding-default">
                <div>
                  <label className="onboarding-section-title" htmlFor="onboarding-default">
                    Start new threads with
                  </label>
                  <p className="onboarding-section-copy" id="onboarding-default-hint">
                    You can switch agents in any thread.
                  </p>
                </div>
                <Select id="onboarding-default" aria-describedby="onboarding-default-hint" value={defaultHarness ?? ""} onChange={(event) => chooseDefault(event.target.value as HarnessId)}>
                  <option value="" disabled>
                    Choose an agent
                  </option>
                  {selectedReady.map((row) => (
                    <option key={row.id} value={row.id}>
                      {harnessCatalog[row.id].name}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            {step === "scan" && !preview && rescanFailed ? (
              <p className="onboarding-feedback" role="alert">
                Couldn’t refresh agent status. The last results are shown. Try Rescan again.
              </p>
            ) : null}
            {step === "theme" ? <ThemeStep preview={preview} onStorageError={setStorageError} /> : null}
            {step === "project" ? (
              <ProjectStep
                projects={projectList}
                selectedId={selectedProject}
                importing={importing}
                loading={!preview && projectLoading}
                loadFailed={!preview && projectLoadFailed}
                error={importError}
                onRetry={retryProjects}
                onSelect={setSelectedProject}
                onImport={() => void chooseRepository()}
              />
            ) : null}
            {step === "done" ? (
              <div className="onboarding-finish">
                <div>
                  <OnboardingMascot mood={storageError ? "reassuring" : "celebrating"} />
                  <h1 tabIndex={-1}>Ready to work</h1>
                  <p>
                    {readyMessage(selectedReady)}
                    {selectedProject ? " and your first project is connected." : "."}
                  </p>
                  <div className="onboarding-action-buttons">
                    <Button variant="primary" onClick={complete}>
                      Start your first thread <ArrowRight size={14} />
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
        {step !== "done" ? (
          <footer className="onboarding-actions onboarding-footer">
            <p className="onboarding-action-note">{setupActionNote({ step, selectedCount: selectedReady.length, readyCount: ready.length, defaultHarness, preview, selectedProject })}</p>
            <div className="onboarding-action-buttons">
              {step !== "scan" ? (
                <Button onClick={retreat} disabled={importing}>
                  <ArrowLeft size={14} /> Back
                </Button>
              ) : null}
              <Button variant="primary" disabled={!canContinue} onClick={advance}>
                {step === "project" ? "Finish setup" : "Continue"} <ArrowRight size={14} />
              </Button>
            </div>
          </footer>
        ) : null}
        {storageError ? (
          <p className="text-sm text-bad mt-3" role="alert">
            Setup progress could not be saved. Keep this window open and try again.
          </p>
        ) : null}
      </main>
    </div>
  );
}
