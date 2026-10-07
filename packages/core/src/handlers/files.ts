import { listSkills } from "@openorc/agents";
import { Db, projects } from "@openorc/db";
import { WORKSPACE_ID, type Project, type RpcParams } from "@openorc/protocol";
import { FileService } from "../services/files.js";
import { directory, workspaceHome } from "../services/workspace-home.js";
import { taskAndProject, threadAndProject } from "./context.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  db: Db;
  files: Pick<FileService, "search" | "read">;
};

async function fileProject(db: Db, scope: RpcParams<"files.read">["scope"]): Promise<Project> {
  if (scope.kind === "thread") {
    const { thread, project } = threadAndProject(db, scope.id);
    return { ...project, rootPath: thread.workingDirectory ?? thread.worktreePath ?? project.rootPath };
  }
  if (scope.kind === "task") {
    const { task, project } = taskAndProject(db, scope.id);
    return { ...project, rootPath: task.worktreePath ?? project.rootPath };
  }
  const project = scope.id === WORKSPACE_ID ? workspaceHome(db) : projects.get(db, scope.id);
  if (!project) throw new Error(`project ${scope.id} not found`);
  if (scope.workingDirectory && scope.workingDirectory !== project.rootPath && project.id !== WORKSPACE_ID) throw new Error("Only Workspace conversations can choose a working folder.");
  return { ...project, rootPath: scope.workingDirectory ? await directory(scope.workingDirectory) : project.rootPath };
}

export function createFilesHandlers({ db, files }: Dependencies): Pick<Handlers, "skills.list" | "files.search" | "files.read"> {
  return {
    "skills.list": async ({ projectId, workingDirectory, agent }) => {
      const project = projectId === WORKSPACE_ID ? workspaceHome(db) : projects.get(db, projectId);
      if (!project) throw new Error(`project ${projectId} not found`);
      if (workingDirectory && project.id !== WORKSPACE_ID) throw new Error("Only Workspace conversations can choose a working folder.");
      return listSkills({ projectRoot: workingDirectory ? await directory(workingDirectory) : project.rootPath, agent });
    },
    "files.search": async ({ projectId, scope, query, limit }) => {
      const project = scope ? await fileProject(db, scope) : projects.get(db, projectId);
      if (!project) throw new Error(`project ${projectId} not found`);
      if (project.id !== projectId) throw new Error("The file scope belongs to another project.");
      return files.search(project, query, limit);
    },
    "files.read": async ({ scope, path }) => files.read((await fileProject(db, scope)).rootPath, path),
  };
}
