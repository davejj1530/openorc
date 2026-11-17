import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { projects, type Db } from "@openorc/db";
import { git, packMacWork, type MacWorkPack } from "@openorc/git";
import type { MacWorkUpload } from "@openorc/hosted";
import type { MacStartPlan } from "@openorc/protocol";
import { macOrigins } from "./mac-projects.js";

/**
 * A project folder's work for a cloud thread started from it (cloud parity unit 5a), or a thread's own folder as it moves
 * to the cloud (CloudMoves), packed here before anything leaves:
 * what goes beyond GitHub's copy of the folder's base branch, as git's `packMacWork` decides it. Null when the folder
 * holds nothing GitHub lacks.
 */
export async function packProject(db: Db, projectId: string, include: readonly string[], folder?: string): Promise<MacWorkPack | null> {
  const project = projects.get(db, projectId);
  if (!project) throw new Error("That project isn't on this Mac.");
  // A thread moving to the cloud packs its own folder: its worktree, or the checkout it works in.
  const at = folder ?? project.rootPath;
  const pack = await packMacWork(at, { baseRef: await baseRefOf(db, projectId, at), include });
  if (pack.commits.length || pack.changed.length || pack.added.length || pack.held.length) return pack;
  await removePack(pack);
  return null;
}

/**
 * What the folder's work goes beyond: for a folder made a Personal project with no remote, the commit its history
 * arrived at, which the folder must still hold; otherwise GitHub's copy of its base branch.
 */
async function baseRefOf(db: Db, projectId: string, folder: string): Promise<string> {
  const origin = macOrigins(db).get(projectId);
  if (!origin) return githubBaseRef(folder);
  if (!origin.head) throw new Error("This project's history hasn't reached OpenOrc Cloud yet.");
  const held = await git(folder, ["cat-file", "-e", `${origin.head}^{commit}`], { okCodes: [0, 1, 128] });
  if (held.code !== 0) throw new Error(HISTORY_GONE);
  return origin.head;
}

/** A folder whose history was rewritten past what it sent when it was added: the origin is written once. */
export const HISTORY_GONE = "This folder's history no longer meets what was sent when it was added. Remove the project and add it again.";

/** GitHub's copy of the folder's base branch: the remote's own head, else its main or master. */
async function githubBaseRef(folder: string): Promise<string> {
  const head = (await git(folder, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], { okCodes: [0, 1, 128] })).stdout.trim();
  if (head) return head;
  for (const ref of ["refs/remotes/origin/main", "refs/remotes/origin/master"]) {
    if ((await git(folder, ["rev-parse", "-q", "--verify", ref], { okCodes: [0, 1, 128] })).code === 0) return ref;
  }
  throw new Error("This folder has no copy of its branch on GitHub. Fetch it, then try again.");
}

const removePack = async (pack: MacWorkPack) => {
  if (pack.file) await rm(path.dirname(pack.file), { recursive: true, force: true });
};

/** What the line before Start says of a pack; the pack itself is removed, as nothing is sent from a plan. */
export async function planOf(pack: MacWorkPack | null): Promise<MacStartPlan> {
  if (!pack) return { state: "nothing" };
  await removePack(pack);
  const { commits, changed, added, held, bytes, largest, refusal } = pack;
  return { state: "ready", commits, changed, added, held, bytes, largest, refusal };
}

/** A pack as the account sends it: streamed from its file, which goes once it is sent or refused. */
export function uploadOf(pack: MacWorkPack): MacWorkUpload {
  const done = () => removePack(pack);
  if (pack.refusal || !pack.file) return { refusal: pack.refusal ?? "This folder's work could not be packed.", done };
  const file = pack.file;
  return { query: pack.query, refusal: null, chunks: () => createReadStream(file), done };
}
