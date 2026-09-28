import { Db } from "@openorc/db";
import { WORKSPACE_ID } from "@openorc/protocol";
import { ProjectService } from "../services/projects.js";
import { configureWorkspace, workspaceHome } from "../services/workspace-home.js";
import { type Transport } from "../transport.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  db: Db;
  projectService: Pick<ProjectService, "list" | "get" | "import" | "remove" | "updateSettings">;
  invalidate: (keys: string[]) => void;
  transport: Transport;
};

export function createProjectsHandlers({
  db,
  projectService,
  invalidate,
  transport,
}: Dependencies): Pick<Handlers, "workspace.get" | "workspace.configure" | "projects.list" | "projects.get" | "projects.import" | "projects.remove" | "projects.updateSettings"> {
  return {
    "workspace.get": () => workspaceHome(db),
    "workspace.configure": async ({ entrypoint }) => {
      const home = await configureWorkspace(db, entrypoint);
      transport.push({ type: "invalidate", keys: ["workspace", "projects"] });
      return home;
    },
    "projects.list": () => projectService.list(),
    "projects.get": ({ id }) => (id === WORKSPACE_ID ? workspaceHome(db) : projectService.get(id)),
    "projects.import": async ({ rootPath }) => {
      const p = await projectService.import(rootPath);
      invalidate(["projects"]);
      return p;
    },
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
