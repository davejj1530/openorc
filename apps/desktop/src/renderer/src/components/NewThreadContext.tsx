import { WORKSPACE_ID, type Project, type WorkspaceMode } from "@openorc/protocol";
import { ComposerChoice } from "./Composer";
import { GitBranch, Laptop } from "./icons";
import { Button } from "./ui";
import { useLayout } from "../lib/layout";

const workspaceOptions = [
  { value: "current" as const, label: "Local checkout", hint: "The repository as it is checked out now", icon: Laptop },
  { value: "worktree" as const, label: "Worktree", hint: "A branch and folder of its own, so other threads never collide with it", icon: GitBranch },
];

/** Choose the destination before writing, while keeping each project's draft separate. */
export function NewThreadContext(props: {
  projectId: string;
  projects: Project[] | undefined;
  mode: WorkspaceMode;
  blocked: string | null;
  disabled: boolean;
  onProject: (id: string) => void;
  onFolder: (folder: string) => void;
  onMode: (mode: WorkspaceMode) => void;
}) {
  const options = (props.projects ?? []).map((project) => ({ value: project.id, label: project.id === WORKSPACE_ID ? "Workspace" : project.name, hint: project.rootPath, hidden: false }));
  if (!options.some((option) => option.value === props.projectId)) {
    options.push({ value: props.projectId, label: props.projects ? "Unavailable project" : "Choose project", hint: "Choose an available project", hidden: true });
  }
  const chooseFolder = async () => {
    const folder = await window.openorc.pickDirectory();
    if (folder) props.onFolder(folder);
  };
  return (
    <div className="new-thread-context" role="group" aria-label="New thread context">
      <ComposerChoice
        ariaLabel="Project"
        className="new-thread-project"
        value={props.projectId}
        options={options}
        side="bottom"
        align="start"
        disabled={props.disabled || !props.projects?.length}
        onChange={(id) => {
          useLayout.getState().setProject(id);
          props.onProject(id);
        }}
      />
      {props.projectId === WORKSPACE_ID ? (
        <Button variant="ghost" size="sm" disabled={props.disabled} title="Choose the folder for this conversation" onClick={() => void chooseFolder()}>
          Choose folder
        </Button>
      ) : (
        <ComposerChoice
          ariaLabel="Where the thread works"
          value={props.mode}
          options={workspaceOptions}
          side="bottom"
          align="start"
          disabled={props.disabled || Boolean(props.blocked)}
          disabledReason={props.blocked ?? undefined}
          onChange={props.onMode}
        />
      )}
    </div>
  );
}
