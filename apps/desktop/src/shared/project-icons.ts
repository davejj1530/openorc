export interface ProjectIconCandidate {
  /** Repository-relative for discovered icons; absolute for a manually picked file. */
  path: string;
  dataUrl: string;
}

export interface ProjectIconState {
  mode: "auto" | "manual" | "folder";
  selected: ProjectIconCandidate | null;
  candidates: ProjectIconCandidate[];
  /** Bundled framework/language mark, used only in automatic mode without a repository image. */
  fallback: ProjectStackIconId | null;
}

export type ProjectIconChoice = { mode: "auto" } | { mode: "folder" } | { mode: "manual"; path: string };

export interface ProjectIconsApi {
  get(rootPath: string): Promise<ProjectIconState>;
  refresh(rootPath: string): Promise<ProjectIconState>;
  choose(rootPath: string, choice: ProjectIconChoice): Promise<ProjectIconState>;
  pick(rootPath: string): Promise<ProjectIconState | null>;
  onChanged(callback: (rootPath: string, state: ProjectIconState) => void): () => void;
}
import type { ProjectStackIconId } from "./project-stack-icons";
