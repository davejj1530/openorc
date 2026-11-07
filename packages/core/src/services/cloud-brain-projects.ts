import { createHash } from "node:crypto";
import { brainTakesProject, branchHead, bundleBranch, type BrainControlResults, type BrainMachine, type CopySettings } from "@openorc/cloud";
import { projects, type Db } from "@openorc/db";
import { defaultBranch, git, originUrl } from "@openorc/git";
import type { CloudBrainCopy, CloudBrainProject, Project } from "@openorc/protocol";
import { projectGit } from "./project-git.js";

/** A Mac project switched on for the cloud brain, kept in the brain's record so removing the brain forgets it. */
export interface BrainProject {
  /** The Mac project's id, which the brain keys its copy by. */
  id: string;
  /** The brain's project for it, once the brain has a copy. */
  brainId: string | null;
  /** The branch its copy follows: the Mac project's default branch as the brain last took it. */
  branch: string;
  /** The Mac's commit the brain last took; null until it has a copy. */
  sent: string | null;
  /** The copy's own commit on the branch, as the brain last said: another than `sent` once it kept commits of its own. */
  head: string | null;
  /** Threads the brain had in the copy, as it last said. */
  threads: number;
  /** Why the last send failed. */
  error: string | null;
  /** The print of the project settings the copy last took; absent until it took any. */
  settings?: string;
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

export const hasThreads = "It has threads on the cloud brain.";

/** This Mac's projects, Workspace aside, and which the brain has a copy of, as Settings lists them. */
export async function projectsShown(db: Db, kept: readonly BrainProject[], sending: string | null): Promise<CloudBrainProject[]> {
  const records = new Map(kept.map((record) => [record.id, record]));
  const listed = projects.list(db);
  // A project removed from this Mac's list keeps its copy until switched off here.
  const unlisted = [...records.keys()].filter((id) => !listed.some((project) => project.id === id)).flatMap((id) => projects.get(db, id) ?? []);
  return Promise.all(
    [...listed, ...unlisted].map(async (project) => {
      const record = records.get(project.id);
      const shown = { on: record !== undefined, blocked: await blocked(project, record), sending: sending === project.id, kept: record ? keptOwn(record) : false };
      return { id: project.id, name: project.name, ...shown, error: record?.error ?? null, branch: record?.branch ?? null };
    }),
  );
}

/** Why a project's switch cannot move now: on, the brain has threads in its copy; off, it cannot have a copy. */
export async function blocked(project: Project, record: BrainProject | undefined): Promise<string | null> {
  if (record) return record.threads ? hasThreads : null;
  const copy = await copyBranch(project);
  return "blocked" in copy ? copy.blocked : null;
}

/** The branch a copy of the project follows, its default unless given, or why the project cannot have one. */
export async function copyBranch(project: Project, followed?: string): Promise<{ branch: string } | { blocked: string }> {
  const state = await projectGit(project).catch(() => null);
  if (state === null) return { blocked: "Its folder is missing." };
  if (state === "none") return { blocked: "Not a Git repository." };
  if (state === "no_commits") return { blocked: "No commits yet." };
  const branch = followed ?? (await following(project));
  if (!branch) return { blocked: "No default branch." };
  if (!brainTakesProject(project.name, branch)) return { blocked: "The cloud brain can't take this project's name or branch." };
  return (await branchHead(project.rootPath, branch)) ? { branch } : { blocked: `No commits on ${branch}.` };
}

/** What a copy of the project takes now: the branch it follows, the commit that branch is on, and the branch checked out here when another. */
export async function copyPreview(project: Project): Promise<CloudBrainCopy> {
  const copy = await copyBranch(project);
  if ("blocked" in copy) throw new Error(copy.blocked);
  const [log, current] = await Promise.all([
    git(project.rootPath, ["log", "-1", "--format=%h%x00%s", `refs/heads/${copy.branch}`]),
    git(project.rootPath, ["branch", "--show-current"], { okCodes: [0, 128] }),
  ]);
  const [commit = "", subject = ""] = log.stdout.trim().split("\0");
  const here = current.stdout.trim();
  return { branch: copy.branch, commit, subject, checkedOut: here && here !== copy.branch ? here : null };
}

/** The project's default branch as git has it now, which a copy follows when it moves, as from master to main. */
async function following(project: Project, record?: BrainProject): Promise<string | null> {
  const known = project.defaultBranch ?? record?.branch ?? null;
  return (await defaultBranch(project.rootPath, known).catch(() => null)) ?? known;
}

/** The branch the copy follows now and the commit it is on here. */
async function now(project: Project, record: BrainProject): Promise<{ branch: string; head: string | null }> {
  const branch = (await following(project, record)) ?? record.branch;
  return { branch, head: await branchHead(project.rootPath, branch).catch(() => null) };
}

/** Whether the project's default branch, or the commit it is on, is another than the brain last took. */
export async function moved(project: Project, record: BrainProject): Promise<boolean> {
  const { branch, head } = await now(project, record);
  return branch !== record.branch || head !== record.sent;
}

/** The settings a copy takes from its Mac project: what runs and is copied into each new thread's folder, and its branch names. */
function copySettings({ settings }: Project): CopySettings {
  return { setupScript: settings.setupScript, branchPrefix: settings.branchPrefix, worktreeInclude: settings.worktreeInclude };
}

const settingsPrint = (project: Project) =>
  createHash("sha256")
    .update(JSON.stringify(copySettings(project)))
    .digest("base64url");

/** Whether the brain's copy lacks the project's settings as they are now. */
const settingsMoved = (project: Project, record: BrainProject) => record.brainId !== null && record.settings !== settingsPrint(project);

/** Whether the brain's copy lacks the project's branch or its settings as they are on this Mac. */
export async function stale(project: Project, record: BrainProject): Promise<boolean> {
  return settingsMoved(project, record) || (await moved(project, record));
}

/**
 * Brings the brain's copy up to the project here: its branch when it moved, then its settings, as the project's other
 * settings reach the copy, so its setup script runs in the brain's thread sandboxes too.
 */
export async function freshCopy(machine: Pick<BrainMachine, "importProject" | "control">, project: Project, record: BrainProject): Promise<BrainProject> {
  const sent = (await moved(project, record)) ? await sendProject(machine, project, record) : record;
  if (!settingsMoved(project, sent)) return sent;
  const { applied } = await machine.control({ op: "project-settings", source: project.id, settings: copySettings(project) });
  return applied ? { ...sent, settings: settingsPrint(project) } : sent;
}

/**
 * Whether a project the brain has a copy of moved on this Mac since the brain took it, read here without asking the
 * brain. A project whose last send failed at the commit its branch is on now waits until the branch moves again.
 */
export async function anyMoved(db: Db, records: readonly BrainProject[], stuck: ReadonlyMap<string, string | null>): Promise<boolean> {
  for (const record of records) {
    const project = record.brainId ? projects.get(db, record.id) : null;
    const { branch, head } = project ? await now(project, record) : { branch: record.branch, head: null };
    if (project && (branch !== record.branch || head !== record.sent) && !(stuck.has(record.id) && stuck.get(record.id) === head)) return true;
    if (project && !record.error && settingsMoved(project, record)) return true;
  }
  return false;
}

/**
 * Tells the brain which copies hold this Mac's branch as it is now, so the phone's "synced" age counts from this look
 * rather than from the last commit sent. A brain from before this request refuses it; nothing else depends on it.
 */
export async function confirmCurrent(machine: Pick<BrainMachine, "control">, db: Db, records: readonly BrainProject[]): Promise<void> {
  const copies: { source: string; macHead: string }[] = [];
  for (const record of records) {
    const project = record.brainId && record.sent ? projects.get(db, record.id) : null;
    if (project && record.sent && !(await moved(project, record))) copies.push({ source: record.id, macHead: record.sent });
  }
  if (copies.length) await machine.control({ op: "copies-current", copies }).catch(() => undefined);
}

/** Each project whose last send failed, with the commit its branch was on then. */
export async function failedAt(db: Db, records: readonly BrainProject[]): Promise<Map<string, string | null>> {
  const failed = new Map<string, string | null>();
  for (const record of records) {
    const project = record.error ? projects.get(db, record.id) : null;
    if (project) failed.set(record.id, (await now(project, record)).head);
  }
  return failed;
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
 * Sends the brain what it lacks of the project's default branch: what came after the last commit it took, or the whole
 * branch the first time and whenever its copy lacks that commit. A default that moved, as from master to main, goes as
 * the branch the copy follows from now on.
 */
export async function sendProject(machine: Pick<BrainMachine, "importProject">, project: Project, record: BrainProject): Promise<BrainProject> {
  const copy = await copyBranch(project, (await now(project, record)).branch);
  if ("blocked" in copy) throw new Error(copy.blocked);
  const { branch } = copy;
  const url = await origin(project.rootPath);
  const send = async (bundle: Buffer) => machine.importProject({ source: project.id, name: project.name, branch, bundle, ...(url ? { origin: url } : {}) });
  const first = await bundleBranch(project.rootPath, branch, record.sent);
  let reply = await send(first.bytes);
  if ("lacksBase" in reply && first.incremental) reply = await send((await bundleBranch(project.rootPath, branch, null)).bytes);
  if ("lacksBase" in reply) throw new Error("The cloud brain could not take this project's branch.");
  return { ...record, branch, brainId: reply.projectId, sent: reply.macHead, head: reply.head, error: null };
}
