import { brainTakesProject, branchHead, bundleBranch, type BrainControlResults, type BrainMachine } from "@openorc/cloud";
import { defaultBranch, originUrl } from "@openorc/git";
import type { Project } from "@openorc/protocol";
import { projectGit } from "./project-git.js";

/** A Mac project switched on for the cloud brain, kept in the brain's record so removing the brain forgets it. */
export interface BrainProject {
  /** The Mac project's id, which the brain keys its copy by. */
  id: string;
  /** The brain's project for it, once the brain has a copy. */
  brainId: string | null;
  /** The branch its copy follows: the Mac project's default branch when it was switched on. */
  branch: string;
  /** The Mac's commit the brain last took; null until it has a copy. */
  sent: string | null;
  /** The copy's own commit on the branch, as the brain last said: another than `sent` once it kept commits of its own. */
  head: string | null;
  /** Threads the brain had in the copy, as it last said. */
  threads: number;
  /** Why the last send failed. */
  error: string | null;
}

export function switchedOn(id: string, branch: string): BrainProject {
  return { id, brainId: null, branch, sent: null, head: null, threads: 0, error: null };
}

/**
 * The record as the brain's own list of copies has it, which wins over what this Mac last heard: a copy the brain lacks,
 * as after its disk went back to an older snapshot or it was set up again, is sent whole at the next refresh. A failure
 * from before is past: the refresh sends again whatever the copy still lacks.
 */
export function seen(record: BrainProject, copies: BrainControlResults["projects"]["copies"]): BrainProject {
  const copy = copies.find((each) => each.source === record.id);
  if (!copy) return switchedOn(record.id, record.branch);
  return { ...record, brainId: copy.projectId, sent: copy.macHead, head: copy.head, threads: copy.threads, error: null };
}

export const keptOwn = (project: BrainProject) => project.head !== null && project.head !== project.sent;

/** The branch a copy of the project follows, its default unless given, or why the project cannot have one. */
export async function copyBranch(project: Project, followed?: string): Promise<{ branch: string } | { blocked: string }> {
  const state = await projectGit(project).catch(() => null);
  if (state === null) return { blocked: "Its folder is missing." };
  if (state === "none") return { blocked: "Not a Git repository." };
  if (state === "no_commits") return { blocked: "No commits yet." };
  const branch = followed ?? project.defaultBranch ?? (await defaultBranch(project.rootPath));
  if (!branch) return { blocked: "No default branch." };
  if (!brainTakesProject(project.name, branch)) return { blocked: "The cloud brain can't take this project's name or branch." };
  return (await branchHead(project.rootPath, branch)) ? { branch } : { blocked: `No commits on ${branch}.` };
}

/** Whether the project's branch is on a commit other than the one the brain last took. */
export async function moved(project: Project, record: BrainProject): Promise<boolean> {
  return (await branchHead(project.rootPath, record.branch).catch(() => null)) !== record.sent;
}

/** An origin to hand on, without a sign-in an https URL carries. */
async function origin(root: string): Promise<string | null> {
  const url = await originUrl(root);
  const parsed = url && URL.canParse(url) ? new URL(url) : null;
  if (!parsed || !/^https?:$/.test(parsed.protocol) || (!parsed.username && !parsed.password)) return url;
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

/**
 * Sends the brain what it lacks of the project's branch: what came after the last commit it took, or the whole branch
 * the first time and whenever its copy lacks that commit.
 */
export async function sendProject(machine: Pick<BrainMachine, "importProject">, project: Project, record: BrainProject): Promise<BrainProject> {
  const copy = await copyBranch(project, record.branch);
  if ("blocked" in copy) throw new Error(copy.blocked);
  const url = await origin(project.rootPath);
  const send = async (bundle: Buffer) => machine.importProject({ source: project.id, name: project.name, branch: record.branch, bundle, ...(url ? { origin: url } : {}) });
  const first = await bundleBranch(project.rootPath, record.branch, record.sent);
  let reply = await send(first.bytes);
  if ("lacksBase" in reply && first.incremental) reply = await send((await bundleBranch(project.rootPath, record.branch, null)).bytes);
  if ("lacksBase" in reply) throw new Error("The cloud brain could not take this project's branch.");
  return { ...record, brainId: reply.projectId, sent: reply.macHead, head: reply.head, error: null };
}
