import { z } from "zod";

/** Where a mac project's history stands: sent, on its way (bytes of bytes), or not sent, with why. */
export type MacProjectSending = { at: "sent" } | { at: "sending"; sent: number; total: number } | { at: "failed"; error: string };

/** A Personal project from a folder of this Mac with no remote: its cloud id, its name, and the folder it came from. */
export type MacProjectRow = { hostedProjectId: string; name: string; localProjectId: string | null; folder: string | null; sending: MacProjectSending };

/** A folder of this Mac with no GitHub remote that could become a Personal project. */
export type MacFolder = { localProjectId: string; name: string; folder: string };

/** Mac projects and the folders that could be one, or none where the server keeps none. */
export type MacProjects = { state: "ready"; personalSpaceId: string; projects: MacProjectRow[]; folders: MacFolder[] } | { state: "unavailable" };

/** Whether a thread's work can come to this Mac now, and what making it current would end there; or why not. */
export type BringState = { mac: false } | { mac: true; can: true; ends: string[] } | { mac: true; can: false; reason: string };

/** What a bring came to: the work on a branch, or a question first because something running there would end. */
export type BringResult = { brought: { branch: string; commits: number; uncommitted: boolean } } | { confirm: string[] };

const id = z.string().min(1).max(200);

/** Window-only: mac projects, their history's way up, and their threads' work brought back. */
export const hostedMacProjectsRpcParams = {
  "macProjects.read": z.object({}).strict(),
  "macProjects.add": z.object({ localProjectId: id }).strict(),
  "macProjects.retry": z.object({ hostedProjectId: id }).strict(),
  "macProjects.cancel": z.object({ hostedProjectId: id }).strict(),
  "macProjects.unbrought": z.object({ hostedProjectId: id }).strict(),
  "macProjects.bringState": z.object({ threadId: id }).strict(),
  "macProjects.bring": z.object({ threadId: id, endsOk: z.boolean() }).strict(),
};
export interface HostedMacProjectsRpcResults {
  "macProjects.read": MacProjects;
  "macProjects.add": MacProjects;
  "macProjects.retry": MacProjects;
  "macProjects.cancel": MacProjects;
  "macProjects.unbrought": { threads: number };
  "macProjects.bringState": BringState;
  "macProjects.bring": BringResult;
}
