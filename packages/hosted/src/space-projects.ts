import type { SpaceProject } from "@openorc/protocol";
import type { HostedDeps } from "./index.js";
import { CLOUD_PROJECT, githubRepoOf } from "./translate.js";
import { wireProject } from "./wire.js";
import { z } from "zod";

export const scopedProject = wireProject.extend({ space: z.string() });
export type ScopedProject = z.infer<typeof scopedProject>;

/** Every matching local copy belongs in the view; hosted rows attach to its first stable presentation. */
export function spaceProjects(spaceId: string, personal: string, hosted: readonly ScopedProject[], local: ReturnType<HostedDeps["projects"]>): SpaceProject[] {
  const organizationRepos = new Set(hosted.filter((project) => project.space !== personal).map((project) => project.fullName.toLowerCase()));
  const inSpace = hosted.filter((project) => project.space === spaceId);
  const localRows: SpaceProject[] = local.flatMap((project) => {
    const repo = githubRepoOf(project.remote);
    const match = repo ? inSpace.find((row) => row.fullName.toLowerCase() === repo) : undefined;
    const visible = spaceId === personal ? !repo || !organizationRepos.has(repo) : Boolean(match);
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
