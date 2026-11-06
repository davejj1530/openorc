import path from "node:path";
import type { BrainLayout } from "@openorc/cloud";

/** Every Mac project's copies, under a folder named for the Mac project's id. */
export const projectsFolder = (layout: BrainLayout): string => path.join(layout.data, "projects");

/** The Mac project a copy at `rootPath` belongs to, from the folder it lives in; null for a project that is no copy. */
export function macProjectOf(layout: BrainLayout, rootPath: string): string | null {
  return rootPath.startsWith(`${projectsFolder(layout)}${path.sep}`) ? path.basename(path.dirname(rootPath)) : null;
}

/** The skills the Mac chose for cloud sessions, by agent, which the brain's sandboxes get. */
export const skillsFolder = (layout: BrainLayout): string => path.join(layout.data, "cloud-skills");
/** The digest naming the skills kept, beside them so replacing them never takes it. */
export const skillsDigestFile = (layout: BrainLayout): string => path.join(layout.data, "cloud-skills.digest");
