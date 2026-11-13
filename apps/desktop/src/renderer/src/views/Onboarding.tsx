import { useState, type CSSProperties, type ReactNode } from "react";
import { harnessCatalog, type HarnessId, type Project } from "@openorc/protocol";
import { overridesFor, resolveAccentColors, themePresets } from "@openorc/client/theme";
import { ArrowLeft, ArrowRight, Check, FolderGit2, Monitor, Moon, RotateCcw, Settings2, Sun } from "../components/icons";
import { HarnessScan, type HarnessRow, type HarnessRowState } from "../components/HarnessScan";
import { OnboardingMascot, type OnboardingMascotMood } from "../components/OnboardingMascot";
import { OnboardingScene } from "../components/OnboardingScene";
import { Button, Select, TextButton } from "../components/ui";
import { type OnboardingStep, type PersistedOnboardingState } from "../lib/onboarding";
import { useTheme, type ThemeChoice } from "../lib/theme";
import { toHex } from "../lib/color";
import { PaletteSelector } from "../components/PaletteSelector";
import { Wordmark } from "../components/SidebarListHead";
import { useTrafficLights, useWindowsControls } from "../lib/window";
import { useHostChoice } from "../lib/host-choice";
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
                <span className="onboarding-project-path" data-tip={project.rootPath}>
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
          <span className="sr-only">{item.label}</span>
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
      <header className="onboarding-heading">
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

function useOnboardingAppearance(preview: boolean, onStorageError: (failed: boolean) => void) {
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
  const colors: CSSProperties = resolveAccentColors(themePresets.find((item) => item.id === preset)!.colors[resolved], overridesFor(theme.custom, preset, resolved), toHex);
  const resetPreview = () => {
    setPreviewChoice(theme.choice);
    setPreviewPreset(theme.preset);
  };
  return { choice, preset, resolved, colors, custom: theme.custom, chooseMode, choosePreset, resetPreview };
}

function ThemeStep({ appearance }: { appearance: ReturnType<typeof useOnboardingAppearance> }) {
  const { choice, preset, resolved, custom, chooseMode, choosePreset } = appearance;
  return (
    <div className="onboarding-theme">
      <header className="onboarding-heading">
        <h1 tabIndex={-1}>Choose how OpenOrc looks</h1>
        <p>You can change this later in Settings.</p>
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
        <PaletteSelector preset={preset} mode={resolved} custom={custom} onChange={choosePreset} compact />
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

function DefaultHarness({ rows, value, onChange }: { rows: readonly HarnessRow[]; value: HarnessId | null; onChange: (id: HarnessId) => void }) {
  return (
    <div className="onboarding-default">
      <div>
        <label className="onboarding-section-title" htmlFor="onboarding-default">
          Start new threads with
        </label>
        <p className="sr-only" id="onboarding-default-hint">
          You can switch agents in any thread.
        </p>
      </div>
      <Select id="onboarding-default" aria-describedby="onboarding-default-hint" value={value ?? ""} onChange={(event) => onChange(event.target.value as HarnessId)}>
        <option value="" disabled>
          Choose an agent
        </option>
        {rows.map((row) => (
          <option key={row.id} value={row.id}>
            {harnessCatalog[row.id].name}
          </option>
        ))}
      </Select>
    </div>
  );
}

/**
 * Where setup looks for agents, on a PC with WSL: on Windows, or inside a distribution, where OpenOrc then runs.
 * Someone whose agents live in Ubuntu would otherwise find none here and have no way on. Shows nothing anywhere else.
 */
function AgentsPlace() {
  const host = useHostChoice();
  if (!host.options) return null;
  return (
    <div className="onboarding-agent-default">
      <div className="onboarding-default">
        <div>
          <label className="onboarding-section-title" htmlFor="onboarding-host">
            Look for agents on
          </label>
          <p className="sr-only" id="onboarding-host-hint">
            OpenOrc runs where you choose, with the agents, Git and shell installed there.
          </p>
        </div>
        <Select id="onboarding-host" aria-describedby="onboarding-host-hint" value={host.value} disabled={host.pending} onChange={(event) => host.choose(event.target.value)}>
          {host.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>
      {host.refused || host.failed ? (
        <p className="onboarding-feedback" role="alert">
          {host.refused ?? "Could not switch. OpenOrc is still running where it was."}
        </p>
      ) : null}
    </div>
  );
}

type Flow = ReturnType<typeof useOnboardingFlow>;

/** Setup's progress could not be saved: said under the actions, while it stays true. */
function SaveFailed({ shown }: { shown: boolean }) {
  if (!shown) return null;
  return (
    <p className="text-sm text-bad mt-3" role="alert">
      Setup progress could not be saved. Keep this window open and try again.
    </p>
  );
}

/** The scene's mascot for the step in front: the scan's own mood, styling, the project's state, or the finish. */
function setupMood(
  step: OnboardingStep,
  scanMood: OnboardingMascotMood,
  project: { importing: boolean; loading: boolean; failed: boolean; selected: boolean; storageError: boolean },
): OnboardingMascotMood {
  if (step === "theme") return "styling";
  if (step === "project") return projectMood(project.importing, project.loading, project.failed, project.selected);
  if (step === "done") return project.storageError ? "reassuring" : "celebrating";
  return scanMood;
}

/** The agents step: every agent found, the ready ones to choose, and the default once more than one is chosen. */
function ScanStep({ agents, preview }: { agents: Flow["agents"]; preview: boolean }) {
  const { rows, selectedReady, selectedHarnesses, defaultHarness, toggleHarness, chooseDefault, refresh, openSetup, rescanPending, rescanFailed } = agents;
  return (
    <>
      <header className="onboarding-heading">
        <h1 tabIndex={-1}>Use the agents you already have</h1>
      </header>
      <HarnessScan
        rows={rows}
        discloseUnavailable
        compact
        selection={{ mode: "multiple", selectedIds: selectedHarnesses, onChange: toggleHarness }}
        refreshing={!preview && rescanPending}
        onRefresh={refresh}
        onRetry={refresh}
        onConnect={openSetup}
        onSetup={openSetup}
      />
      {selectedReady.length > 1 ? (
        <div className="onboarding-agent-default">
          <DefaultHarness rows={selectedReady} value={defaultHarness} onChange={chooseDefault} />
        </div>
      ) : null}
      {!preview && rescanFailed ? (
        <p className="onboarding-feedback" role="alert">
          Couldn’t refresh agent status. The last results are shown. Try Rescan again.
        </p>
      ) : null}
      {preview ? null : <AgentsPlace />}
    </>
  );
}

/** Back, the progress track and the step's one action; a step that cannot go on says why on its button. */
function SetupFooter({
  step,
  canContinue,
  busy,
  note,
  onBack,
  onNext,
  onComplete,
}: {
  step: OnboardingStep;
  canContinue: boolean;
  busy: boolean;
  note: string;
  onBack: () => void;
  onNext: () => void;
  onComplete: () => void;
}) {
  return (
    <footer className="onboarding-actions onboarding-footer" data-complete={step === "done" || undefined}>
      <div className="onboarding-back">
        {step !== "scan" && step !== "done" ? (
          <Button size="xl" onClick={onBack} disabled={busy}>
            <ArrowLeft size={14} /> Back
          </Button>
        ) : null}
      </div>
      <Progress step={step} />
      <div className="onboarding-action-buttons">
        {step === "done" ? (
          <Button variant="primary" size="xl" onClick={onComplete}>
            Start your first thread <ArrowRight size={14} />
          </Button>
        ) : (
          <Button variant="primary" size="xl" disabled={!canContinue} data-tip={!canContinue ? note : undefined} onClick={onNext}>
            {step === "project" ? "Finish setup" : "Continue"} <ArrowRight size={14} />
          </Button>
        )}
      </div>
    </footer>
  );
}

/** Agents stopped working after setup: the scan again, with Return once one of them is ready. */
function RecoveryScreen({ page, agents, storageError, onClose, onReturn }: { page: Flow["page"]; agents: Flow["agents"]; storageError: boolean; onClose: () => void; onReturn: () => void }) {
  const { rows, scanMood, rescanPending, rescanFailed, refresh, openSetup } = agents;
  const canReturn = rows.some((row) => row.state === "ready");
  return (
    <div className="onboarding-root">
      <OnboardingChrome>
        <span className="onboarding-brand">
          <Wordmark />
        </span>
        <span className="onboarding-chrome-label" />
        <TextButton className="onboarding-preview-trigger" tone="muted" onClick={onClose}>
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
            <Button variant="primary" size="xl" disabled={!canReturn} onClick={onReturn}>
              Return to OpenOrc
            </Button>
          </div>
        </footer>
        <SaveFailed shown={storageError} />
      </main>
    </div>
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
  const appearance = useOnboardingAppearance(preview, setStorageError);
  const { step, setStep, advance, retreat, complete, completeRecovery, closeRecovery } = progress;
  const { rows, ready, selectedReady, selectedHarnesses, defaultHarness, scanMood } = agents;
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

  if (mode === "recovery") return <RecoveryScreen page={page} agents={agents} storageError={storageError} onClose={closeRecovery} onReturn={completeRecovery} />;

  const scanCanContinue = selectedReady.length > 0 && defaultHarness !== null;
  const projectCanContinue = selectedProject !== null && !importing;
  const canContinue = canContinueSetup(step, scanCanContinue, projectCanContinue);
  const sceneMood = setupMood(step, scanMood, {
    importing,
    loading: !preview && projectLoading,
    failed: Boolean(importError || (!preview && projectLoadFailed)),
    selected: Boolean(selectedProject),
    storageError,
  });
  const sceneReaction = step === "theme" ? `${appearance.choice}:${appearance.preset}` : `${selectedHarnesses.join(":")}:${defaultHarness}:${selectedProject}`;

  return (
    <div className="onboarding-root onboarding-setup">
      <OnboardingChrome>
        <span className="onboarding-brand">
          <Wordmark />
        </span>
        <span className="onboarding-chrome-label">Set up your workspace</span>
        {import.meta.env.DEV ? (
          <TextButton className="onboarding-preview-trigger" tone="muted" onClick={onTogglePreview}>
            <Settings2 size={13} /> {preview ? "Use live state" : "Preview states"}
          </TextButton>
        ) : (
          <span />
        )}
      </OnboardingChrome>
      {preview ? (
        <PreviewTools
          step={step}
          rows={rows}
          onStep={setStep}
          onState={previewControls.setRowState}
          onReplay={() => setStep("scan")}
          onReset={() => {
            previewControls.reset();
            appearance.resetPreview();
          }}
        />
      ) : null}
      <main className="onboarding-surface">
        <div className="onboarding-body" data-step={step}>
          <div className="onboarding-scroll">
            <div className="onboarding-page" ref={page} key={step}>
              {step === "scan" ? <ScanStep agents={agents} preview={preview} /> : null}
              {step === "theme" ? <ThemeStep appearance={appearance} /> : null}
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
                    <h1 tabIndex={-1}>Ready to work</h1>
                    <p>
                      {readyMessage(selectedReady)}
                      {selectedProject ? " and your first project is connected." : "."}
                    </p>
                  </div>
                </div>
              ) : null}
              {step !== "done" && step !== "theme" && !(step === "scan" && selectedReady.length > 1) ? (
                <div className="onboarding-step-note">
                  <p className="onboarding-action-note">{setupActionNote({ step, selectedCount: selectedReady.length, readyCount: ready.length, defaultHarness, preview, selectedProject })}</p>
                </div>
              ) : null}
            </div>
          </div>
          <OnboardingScene
            step={step}
            mood={sceneMood}
            reactionKey={sceneReaction}
            agents={selectedReady.map((row) => row.id)}
            projectName={projectList.find((item) => item.id === selectedProject)?.name}
            colors={appearance.colors}
            preset={appearance.preset}
            mode={appearance.resolved}
          />
        </div>
        <SetupFooter
          step={step}
          canContinue={canContinue}
          busy={importing}
          note={setupActionNote({ step, selectedCount: selectedReady.length, readyCount: ready.length, defaultHarness, preview, selectedProject })}
          onBack={retreat}
          onNext={advance}
          onComplete={complete}
        />
        <SaveFailed shown={storageError} />
      </main>
    </div>
  );
}
