import { copySyncedAt } from "@openorc/cloud";
import { Db } from "@openorc/db";
import { WORKSPACE_ID, type Project } from "@openorc/protocol";
import { ProjectService } from "../services/projects.js";
import { configureWorkspace, folderMissing, workspaceHome } from "../services/workspace-home.js";
import { type Transport } from "../transport.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  db: Db;
  projectService: Pick<ProjectService, "list" | "get" | "git" | "checkoutBranch" | "import" | "remove" | "updateSettings">;
  invalidate: (keys: string[]) => void;
  transport: Transport;
  /** On the cloud brain, where each project is the Mac's copy and says how fresh it is. */
  copies?: boolean;
};

/** A project that is the Mac's copy on the cloud brain, with when it last took the Mac's branch or heard GitHub's. */
async function withCopy(project: Project): Promise<Project> {
  const syncedAt = await copySyncedAt(project.rootPath);
  return syncedAt === null ? project : { ...project, copy: { syncedAt } };
}

export function createProjectsHandlers({
  db,
  projectService,
  invalidate,
  transport,
  copies = false,
}: Dependencies): Pick<
  Handlers,
  | "workspace.get"
  | "workspace.configure"
  | "projects.list"
  | "projects.get"
  | "projects.git"
  | "projects.checkoutBranch"
  | "projects.import"
  | "projects.folderMissing"
  | "projects.remove"
  | "projects.updateSettings"
> {
  return {
    "workspace.get": () => workspaceHome(db),
    "workspace.configure": async ({ entrypoint }) => {
      const home = await configureWorkspace(db, entrypoint);
      transport.push({ type: "invalidate", keys: ["workspace", "projects"] });
      return home;
    },
    "projects.list": () => (copies ? Promise.all(projectService.list().map(withCopy)) : projectService.list()),
    "projects.get": ({ id }) => {
      if (id === WORKSPACE_ID) return workspaceHome(db);
      const project = projectService.get(id);
      return copies && project ? withCopy(project) : project;
    },
    "projects.checkoutBranch": ({ id }) => (id === WORKSPACE_ID ? null : projectService.checkoutBranch(id)),
    "projects.git": async ({ id }) => {
      if (id === WORKSPACE_ID) return "none";
      const { state, changed } = await projectService.git(id);
      if (changed) invalidate(["projects", `project:${id}`]);
      return state;
    },
    "projects.import": async ({ rootPath, create }) => {
      const p = await projectService.import(rootPath, { create });
      invalidate(["projects"]);
      return p;
    },
    "projects.folderMissing": ({ rootPath }) => folderMissing(rootPath),
    "projects.updateSettings": ({ id, settings }) => {
      const p = projectService.updateSettings(id, settings);
      invalidate(["projects", `project:${id}`]);
      return p;
    },
    "projects.remove": ({ id }) => {
      projectService.remove(id);
      invalidate(["projects", `project:${id}`]);
      return { ok: true };
    },
  };
}
