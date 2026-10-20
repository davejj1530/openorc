import { WORKSPACE_ID, type Project } from "@openorc/protocol";
import { ComposerChoice } from "./ComposerChoice";
import { Folder } from "./icons";
import { useLayout } from "../lib/layout";

/** The project chip in the New thread composer. Each project keeps its own draft. */
export function NewThreadProjectChoice(props: { projectId: string; projects: Project[] | undefined; disabled: boolean; onProject: (id: string) => void }) {
  const options = (props.projects ?? []).map((project) => ({
    value: project.id,
    label: project.id === WORKSPACE_ID ? "Workspace" : project.name,
    hint: project.rootPath,
    icon: Folder,
    hidden: false,
  }));
  if (!options.some((option) => option.value === props.projectId)) {
    options.push({ value: props.projectId, label: props.projects ? "Unavailable project" : "Choose project", hint: "Choose an available project", icon: Folder, hidden: true });
  }
  return (
    <ComposerChoice
      ariaLabel="Project"
      className="new-thread-project"
      value={props.projectId}
      options={options}
      chevron
      side="bottom"
      align="start"
      disabled={props.disabled || !props.projects?.length}
      onChange={(id) => {
        useLayout.getState().setProject(id);
        props.onProject(id);
      }}
    />
  );
}
