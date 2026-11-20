import type { SpaceProject } from "@openorc/protocol";
import type { HostedDeps } from "./index.js";
import { CLOUD_PROJECT, githubRepoOf } from "./translate.js";
import { z } from "zod";

export const scopedProject = z.object({ id: z.string(), name: z.string(), fullName: z.string().nullable(), connected: z.boolean().default(true), space: z.string() });
export type ScopedProject = z.infer<typeof scopedProject>;

/**
 * Every matching local copy belongs in the view; hosted rows attach to its first stable presentation. Personal holds
 * every folder on this Mac, and an organization also holds those of its own projects.
 */
export function spaceProjects(spaceId: string, personal: string, hosted: readonly ScopedProject[], local: ReturnType<HostedDeps["projects"]>): SpaceProject[] {
  const inSpace = hosted.filter((project) => project.space === spaceId);
  const localRows: SpaceProject[] = local.flatMap((project) => {
    const repo = githubRepoOf(project.remote);
    // A folder with no remote is paired by the project it was added as (`cloudProjectId`).
    const match = repo ? inSpace.find((row) => row.fullName?.toLowerCase() === repo) : inSpace.find((row) => row.id === project.cloudProjectId);
    const visible = spaceId === personal || Boolean(match);
    return visible
      ? [
          {
            key: project.id,
            name: project.name ?? match?.name ?? repo?.split("/").at(-1) ?? project.id,
            repo,
            localProjectId: project.id,
            hostedProjectId: match?.id ?? null,
            connected: match?.connected ?? false,
          },
        ]
      : [];
  });
  const paired = new Set(localRows.map((project) => project.hostedProjectId));
  return [
    ...localRows,
    ...inSpace
      .filter((project) => !paired.has(project.id))
      .map((project) => ({
        key: CLOUD_PROJECT + project.id,
        name: project.name,
        repo: project.fullName,
        localProjectId: null,
        hostedProjectId: project.id,
        connected: project.connected,
      })),
  ];
}
