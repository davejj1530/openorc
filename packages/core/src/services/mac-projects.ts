/**
 * Personal projects from a folder of this Mac with no GitHub remote (cloud parity part 5), as Settings > Cloud adds
 * them and a cloud thread brings its work back. The folder's history is packed here and checked against the limits
 * before anything is made (git's `packMacHistory`); the project is then made and its history sent once, its bytes
 * counted as they go, which the project's row shows. Which folder each mac project came from is kept on this Mac alone:
 * the server never knows a path.
 *
 * Bring: a thread's newest work save, made current first when the thread is still on its machine (which ends what runs
 * there, so the person is asked first only when something would), fetched into the folder as the thread's branch by
 * git's `bringIntoFolder`.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { projects, settings, type Db } from "@openorc/db";
import { bringIntoFolder, BringRefused, git, NOT_THAT_FOLDER, packMacHistory } from "@openorc/git";
import { githubRepoOf, type Hosted } from "@openorc/hosted";
import type { BringResult, BringState, MacProjects as MacProjectsView, MacProjectSending } from "@openorc/protocol";

const FOLDERS = "mac.projects.folders";
const STILL_WORKING = "The agent is still working. Bring its work once it stops.";
const ELSEWHERE = "This project's folder is on another Mac.";
/** How long a bring waits for the thread to leave its machine with a save. */
const CURRENT_MS = 3 * 60_000;
/** How often a send's progress is told to the windows. */
const TOLD_MS = 500;

type Sending = { state: MacProjectSending; abort: AbortController | null };

export class MacProjects {
  /** Each mac project's history on its way from this Mac, or why it didn't go. */
  private readonly sending = new Map<string, Sending>();

  constructor(private readonly deps: { db: Db; hosted: () => Hosted | null; changed: () => void; now?: () => number }) {}

  /** Which local project each mac project came from, kept on this Mac. */
  private folders(): Record<string, string> {
    try {
      return JSON.parse(settings.get(this.deps.db, FOLDERS) ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  }

  private keep(hostedProjectId: string, localProjectId: string | null): void {
    const all = this.folders();
    if (localProjectId) all[hostedProjectId] = localProjectId;
    else delete all[hostedProjectId];
    settings.set(this.deps.db, FOLDERS, JSON.stringify(all));
  }

  private personal(hosted: Hosted): string | null {
    const spaces = hosted.spaces.status();
    return spaces.state === "ready" ? spaces.personalSpaceId : null;
  }

  async read(): Promise<MacProjectsView> {
    const hosted = this.deps.hosted();
    const personal = hosted && this.personal(hosted);
    if (!hosted || !personal || !(await hosted.macProjects.served(personal))) return { state: "unavailable" };
    const cloud = await hosted.macProjects.list(personal);
    const kept = this.folders();
    const local = projects.list(this.deps.db);
    const rows = cloud.map((one) => {
      const localId = kept[one.id] ?? null;
      const folder = localId ? (local.find((each) => each.id === localId)?.rootPath ?? null) : null;
      const sending = this.sending.get(one.id)?.state ?? (one.sent ? { at: "sent" as const } : { at: "failed" as const, error: "Its history didn't arrive." });
      return { hostedProjectId: one.id, name: one.name, localProjectId: localId, folder, sending };
    });
    const taken = new Set(Object.values(kept));
    const folders = local.filter((each) => !githubRepoOf(each.gitRemote) && !taken.has(each.id)).map((each) => ({ localProjectId: each.id, name: each.name, folder: each.rootPath }));
    return { state: "ready", personalSpaceId: personal, projects: rows, folders };
  }

  /** Makes the folder a Personal project and sends its history; refused in words, with nothing made, past the limits. */
  async add(localProjectId: string): Promise<MacProjectsView> {
    const { hosted, personal } = this.ready();
    const project = projects.get(this.deps.db, localProjectId);
    if (!project) throw new Error("That project isn't on this Mac.");
    const pack = await packMacHistory(project.rootPath, project.name);
    if (!("file" in pack)) throw new Error(pack.refusal ?? "This folder's history can't be sent.");
    const made = await hosted.macProjects.create(personal, { name: project.name, branch: pack.branch }).catch(async (error: unknown) => {
      await rm(path.dirname(pack.file), { recursive: true, force: true });
      throw error;
    });
    this.keep(made.id, localProjectId);
    void this.send(made.id, pack);
    return this.read();
  }

  /** Sends the history again, packed afresh, for a project whose history didn't arrive. */
  async retry(hostedProjectId: string): Promise<MacProjectsView> {
    const localId = this.folders()[hostedProjectId];
    const project = localId ? projects.get(this.deps.db, localId) : null;
    if (!project) throw new Error("The folder this project came from isn't on this Mac anymore.");
    const pack = await packMacHistory(project.rootPath, project.name);
    if (!("file" in pack)) throw new Error(pack.refusal ?? "This folder's history can't be sent.");
    void this.send(hostedProjectId, pack);
    return this.read();
  }

  /** Stops a send and takes the project away: a project with no history is nothing to keep. */
  async cancel(hostedProjectId: string): Promise<MacProjectsView> {
    const { hosted, personal } = this.ready();
    this.sending.get(hostedProjectId)?.abort?.abort();
    this.sending.delete(hostedProjectId);
    await hosted.macProjects.remove(personal, hostedProjectId);
    this.keep(hostedProjectId, null);
    return this.read();
  }

  private async send(hostedProjectId: string, pack: { file: string; head: string; bytes: number }): Promise<void> {
    const { hosted, personal } = this.ready();
    const abort = new AbortController();
    const going: Sending = { state: { at: "sending", sent: 0, total: pack.bytes }, abort };
    this.sending.set(hostedProjectId, going);
    this.deps.changed();
    let toldAt = 0;
    const now = this.deps.now ?? Date.now;
    const file = pack.file;
    async function* counted(): AsyncGenerator<Uint8Array> {
      for await (const chunk of createReadStream(file, { signal: abort.signal }) as AsyncIterable<Buffer>) {
        if (going.state.at === "sending") going.state = { ...going.state, sent: going.state.sent + chunk.length };
        yield chunk;
      }
    }
    const tell = () => {
      if (now() - toldAt < TOLD_MS) return;
      toldAt = now();
      this.deps.changed();
    };
    const ticking = setInterval(tell, TOLD_MS);
    try {
      await hosted.macProjects.sendOrigin(personal, hostedProjectId, pack.head, counted);
      this.sending.delete(hostedProjectId);
    } catch (error) {
      if (!abort.signal.aborted) this.sending.set(hostedProjectId, { state: { at: "failed", error: error instanceof Error ? error.message : String(error) }, abort: null });
    } finally {
      clearInterval(ticking);
      await rm(path.dirname(file), { recursive: true, force: true });
      this.deps.changed();
    }
  }

  /** How many of the project's threads have saved commits that never came to its folder on this Mac. */
  async unbrought(hostedProjectId: string): Promise<{ threads: number }> {
    const hosted = this.deps.hosted();
    const folder = this.folderOf(hostedProjectId);
    if (!hosted) return { threads: 0 };
    let count = 0;
    for (const row of hosted.threads.rowsOfProject?.(hostedProjectId) ?? []) {
      const work = await hosted.macProjects.workSave(row.space, row.id).catch(() => null);
      if (!work?.save?.bundle) continue;
      const here = folder && (await git(folder, ["cat-file", "-e", `${work.save.head}^{commit}`], { okCodes: [0, 1, 128] })).code === 0;
      if (!here) count++;
    }
    return { threads: count };
  }

  /** Whether a thread's work can come to this Mac now, and what making it current would end; or why not. */
  async bringState(spaceId: string, threadId: string): Promise<BringState> {
    const hosted = this.deps.hosted();
    if (!hosted) return { mac: false };
    const row = hosted.threads.row?.(threadId);
    if (!row?.projectId) return { mac: false };
    const localId = this.folders()[row.projectId];
    if (!localId) {
      const personal = this.personal(hosted);
      const mac = personal !== null && (await hosted.macProjects.list(personal).catch(() => [])).some((one) => one.id === row.projectId);
      return mac ? { mac: true, can: false, reason: ELSEWHERE } : { mac: false };
    }
    const project = projects.get(this.deps.db, localId);
    if (!project || !(await stat(project.rootPath).catch(() => null))) return { mac: true, can: false, reason: `The folder ${project?.name ?? "this project"} was in isn't on this Mac anymore.` };
    const work = await hosted.macProjects.workSave(spaceId, threadId);
    if (work.working) return { mac: true, can: false, reason: STILL_WORKING };
    if (work.save && (await git(project.rootPath, ["cat-file", "-e", `${work.save.base}^{commit}`], { okCodes: [0, 1, 128] })).code !== 0) return { mac: true, can: false, reason: NOT_THAT_FOLDER };
    if (!work.save && work.current) return { mac: true, can: false, reason: "The thread has no work to bring yet." };
    return { mac: true, can: true, ends: work.current ? [] : work.ends };
  }

  /**
   * Brings the thread's newest commits into the folder as its branch. A thread still on its machine leaves it with a
   * save first; when that would end something running there, the answer asks first (`confirm`) unless `endsOk`.
   */
  async bring(spaceId: string, threadId: string, endsOk: boolean): Promise<BringResult> {
    const hosted = this.deps.hosted();
    const state = await this.bringState(spaceId, threadId);
    if (!hosted || !state.mac) throw new Error("This thread's work has no folder on this Mac to come to.");
    if (!state.can) throw new BringRefused(state.reason);
    if (state.ends.length && !endsOk) return { confirm: state.ends };
    let work = await hosted.macProjects.workSave(spaceId, threadId);
    if (!work.current) {
      await hosted.macProjects.ask(spaceId, threadId);
      const until = Date.now() + CURRENT_MS;
      while (!work.current) {
        if (Date.now() > until) throw new Error("The thread didn't save its work in time. Try again in a moment.");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        work = await hosted.macProjects.workSave(spaceId, threadId);
      }
    }
    const save = work.save;
    if (!save?.bundle) throw new BringRefused("The thread made no commits to bring.");
    const folder = this.folderOf(hosted.threads.row?.(threadId).projectId ?? "");
    if (!folder) throw new BringRefused(ELSEWHERE);
    const dir = await mkdtemp(path.join(os.tmpdir(), "openorc-bring-"));
    try {
      const file = path.join(dir, "work.bundle");
      const response = await hosted.macProjects.bundle(spaceId, threadId, AbortSignal.timeout(10 * 60_000));
      if (!response.body) throw new Error("The thread's saved work didn't arrive. Try again.");
      await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>), createWriteStream(file));
      const brought = await bringIntoFolder(folder, file, { branch: save.branch, head: save.head, base: save.base });
      return { brought: { ...brought, uncommitted: save.uncommitted } };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private folderOf(hostedProjectId: string): string | null {
    const localId = this.folders()[hostedProjectId];
    return (localId && projects.get(this.deps.db, localId)?.rootPath) || null;
  }

  private ready(): { hosted: Hosted; personal: string } {
    const hosted = this.deps.hosted();
    const personal = hosted && this.personal(hosted);
    if (!hosted || !personal) throw new Error("Sign in to OpenOrc to add a project from this Mac.");
    return { hosted, personal };
  }
}
