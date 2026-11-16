import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { projects, type Db } from "@openorc/db";
import { git, packMacWork, type MacWorkPack } from "@openorc/git";
import type { MacWorkUpload } from "@openorc/hosted";
import type { MacStartPlan } from "@openorc/protocol";

/**
 * A project folder's work for a cloud thread started from it (cloud parity unit 5a), packed here before anything leaves:
 * what goes beyond GitHub's copy of the folder's base branch, as git's `packMacWork` decides it. Null when the folder
 * holds nothing GitHub lacks.
 */
export async function packProject(db: Db, projectId: string, include: readonly string[]): Promise<MacWorkPack | null> {
  const project = projects.get(db, projectId);
  if (!project) throw new Error("That project isn't on this Mac.");
  const pack = await packMacWork(project.rootPath, { baseRef: await githubBaseRef(project.rootPath), include });
  if (pack.commits.length || pack.changed.length || pack.added.length || pack.held.length) return pack;
  await removePack(pack);
  return null;
}

/** GitHub's copy of the folder's base branch: the remote's own head, else its main or master. */
async function githubBaseRef(folder: string): Promise<string> {
  const head = (await git(folder, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], { okCodes: [0, 1, 128] })).stdout.trim();
  if (head) return head;
  for (const ref of ["refs/remotes/origin/main", "refs/remotes/origin/master"]) {
    if ((await git(folder, ["rev-parse", "-q", "--verify", ref], { okCodes: [0, 1, 128] })).code === 0) return ref;
  }
  throw new Error("This folder has no copy of its branch on GitHub. Fetch it, then try again.");
}

const removePack = (pack: MacWorkPack) => rm(path.dirname(pack.file), { recursive: true, force: true });

/** What the line before Start says of a pack; the pack itself is removed, as nothing is sent from a plan. */
export async function planOf(pack: MacWorkPack | null): Promise<MacStartPlan> {
  if (!pack) return { state: "nothing" };
  await removePack(pack);
  const { commits, changed, added, held, bytes, largest, refusal } = pack;
  return { state: "ready", commits, changed, added, held, bytes, largest, refusal };
}

/** A pack as the account sends it: streamed from its file, which goes once it is sent or refused. */
export function uploadOf(pack: MacWorkPack): MacWorkUpload {
  return { query: pack.query, refusal: pack.refusal, chunks: () => createReadStream(pack.file), done: () => removePack(pack) };
}
