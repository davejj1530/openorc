import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db, projects } from "@openorc/db";
import { MAC_FILE_BYTES } from "@openorc/git";
import { leaveWithSave, type Hosted } from "@openorc/hosted";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MacProjects, macOrigins } from "./mac-projects.js";
import { HISTORY_GONE, packProject } from "./mac-work.js";

const root = mkdtempSync(path.join(os.tmpdir(), "openorc-mac-projects-core-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "A",
  GIT_AUTHOR_EMAIL: "a@example.com",
  GIT_COMMITTER_NAME: "A",
  GIT_COMMITTER_EMAIL: "a@example.com",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();
let counter = 0;

function folder(content = "first") {
  const at = path.join(root, `folder-${counter++}`);
  git(root, "init", "-q", "-b", "main", at);
  writeFileSync(path.join(at, "a.txt"), content);
  git(at, "add", "-A");
  git(at, "commit", "-q", "-m", "First");
  return at;
}

type Save = { branch: string | null; head: string; base: string; bundle: boolean; uncommitted: boolean; savedAt: string };

/** An account as far as mac projects go: a Personal space, its mac projects, and one thread's work save. */
function account() {
  const cloud: { id: string; name: string; origin: "mac"; defaultBranch: string; sent: boolean }[] = [];
  const received = new Map<string, Buffer>();
  // `asked` as the server names it, or undefined as a server from before it; `stillInUse` as a message arriving as the
  // thread leaves keeps the folder in use, so the save asked for is made and never current.
  const work = { save: null as Save | null, current: true, working: false, ends: [] as string[], bundle: "", asked: false as boolean | undefined, stillInUse: false };
  const asks: string[] = [];
  const rows = [{ id: "thread-1", space: "personal", projectId: "cloud-1" }];
  const hosted = {
    spaces: { status: () => ({ state: "ready", personalSpaceId: "personal" }) },
    macProjects: {
      served: async () => true,
      list: async () => cloud,
      create: async (_space: string, input: { name: string; branch: string }) => {
        const made = { id: `cloud-${cloud.length + 1}`, name: input.name, origin: "mac" as const, defaultBranch: input.branch, sent: false };
        cloud.push(made);
        return made;
      },
      sendOrigin: async (_space: string, id: string, _head: string, chunks: () => AsyncIterable<Uint8Array>) => {
        const parts: Buffer[] = [];
        for await (const chunk of chunks()) parts.push(Buffer.from(chunk));
        received.set(id, Buffer.concat(parts));
        cloud.find((one) => one.id === id)!.sent = true;
        return cloud.find((one) => one.id === id)!;
      },
      remove: async (_space: string, id: string) =>
        void cloud.splice(
          cloud.findIndex((one) => one.id === id),
          1,
        ),
      workSave: async () => ({ save: work.save, current: work.current, working: work.working, ends: work.ends, ...(work.asked === undefined ? {} : { asked: work.asked }) }),
      ask: async (_space: string, threadId: string) => {
        asks.push(threadId);
        work.current = !work.stillInUse;
        work.ends = [];
        return { asked: true };
      },
      // The hosted package's own wait, over this server's answers, with no time passing.
      leave: (space: string, threadId: string, ms: number) =>
        leaveWithSave(
          { workSave: () => hosted.macProjects.workSave(space, threadId), ask: () => hosted.macProjects.ask(space, threadId), withdraw: async () => {}, now: Date.now, pause: async () => {} },
          ms,
        ),
      bundle: async () => new Response(readFileSync(work.bundle)),
    },
    threads: { row: (id: string) => rows.find((row) => row.id === id)!, rowsOfProject: (id: string) => rows.filter((row) => row.projectId === id) },
  } as unknown as Hosted;
  return { hosted, cloud, received, work, asks };
}

let db: Db;
beforeEach(() => {
  db = Db.memory();
});
afterEach(() => db.close());

describe("a Personal project from a folder of this Mac", () => {
  it("lists a folder with no GitHub remote, makes it a project and sends its whole history, counted", async () => {
    const at = folder();
    const local = projects.insert(db, { name: "sketches", rootPath: at, gitRemote: null, defaultBranch: "main", settings: {} });
    projects.insert(db, { name: "api", rootPath: folder("api"), gitRemote: "git@github.com:acme/api.git", defaultBranch: "main", settings: {} });
    const { hosted, received } = account();
    const changed = vi.fn();
    const mac = new MacProjects({ db, hosted: () => hosted, changed });
    expect(await mac.read()).toMatchObject({ state: "ready", projects: [], folders: [{ localProjectId: local.id, name: "sketches", folder: at }] });
    await mac.add(local.id);
    await vi.waitFor(async () => expect((await mac.read()).state === "ready" && ((await mac.read()) as { projects: { sending: unknown }[] }).projects[0]?.sending).toEqual({ at: "sent" }));
    const file = path.join(root, "received.bundle");
    writeFileSync(file, received.get("cloud-1")!);
    expect(git(at, "bundle", "list-heads", file)).toBe(`${git(at, "rev-parse", "HEAD")} refs/heads/main`);
    expect(await mac.read()).toMatchObject({ projects: [{ hostedProjectId: "cloud-1", name: "sketches", localProjectId: local.id, folder: at }], folders: [] });
    expect(changed).toHaveBeenCalled();
  });

  it("keeps the commit the history arrived at, starts a Mac's work from it, and says so when the folder no longer holds it", async () => {
    const at = folder();
    const local = projects.insert(db, { name: "sketches", rootPath: at, gitRemote: null, defaultBranch: "main", settings: {} });
    const { hosted } = account();
    const mac = new MacProjects({ db, hosted: () => hosted, changed: () => {} });
    await mac.add(local.id);
    const head = git(at, "rev-parse", "HEAD");
    await vi.waitFor(() => expect(macOrigins(db).get(local.id)).toEqual({ hostedProjectId: "cloud-1", head }));
    writeFileSync(path.join(at, "b.txt"), "newer");
    git(at, "add", "-A");
    git(at, "commit", "-q", "-m", "Newer");
    writeFileSync(path.join(at, "a.txt"), "edited");
    const pack = await packProject(db, local.id, []);
    expect(pack?.query?.base, "only what the folder has since").toBe(head);
    expect(pack?.commits.map((one) => one.subject)).toEqual(["Newer"]);
    expect(pack?.changed).toEqual(["a.txt"]);
    // History rewritten past what was sent: the folder no longer holds it.
    rmSync(path.join(at, ".git"), { recursive: true, force: true });
    git(root, "init", "-q", "-b", "main", at);
    git(at, "add", "-A");
    git(at, "commit", "-q", "-m", "Again");
    await expect(packProject(db, local.id, [])).rejects.toThrow(HISTORY_GONE);
  });

  it("makes nothing for a folder whose history is over the limits, and says why", async () => {
    const at = folder();
    writeFileSync(path.join(at, "intro.mov"), Buffer.alloc(MAC_FILE_BYTES + 1024 * 1024, 3));
    git(at, "add", "-A");
    git(at, "commit", "-q", "-m", "Video");
    const local = projects.insert(db, { name: "sketches", rootPath: at, gitRemote: null, defaultBranch: "main", settings: {} });
    const { hosted, cloud } = account();
    const mac = new MacProjects({ db, hosted: () => hosted, changed: () => {} });
    await expect(mac.add(local.id)).rejects.toThrow("Too large to send from this Mac: intro.mov (51 MB) in its history, over 50 MB each.");
    expect(cloud).toEqual([]);
  }, 60_000);
});

describe("a thread's work brought to this Mac", () => {
  async function broughtSetUp() {
    const at = folder();
    const local = projects.insert(db, { name: "sketches", rootPath: at, gitRemote: null, defaultBranch: "main", settings: {} });
    const made = account();
    const mac = new MacProjects({ db, hosted: () => made.hosted, changed: () => {} });
    await mac.add(local.id);
    await vi.waitFor(() => expect(made.cloud[0]?.sent).toBe(true));
    const cloud = path.join(root, `cloud-${counter++}`);
    git(root, "clone", "-q", at, cloud);
    const base = git(cloud, "rev-parse", "HEAD");
    git(cloud, "checkout", "-q", "-b", "fix-login");
    writeFileSync(path.join(cloud, "fix.txt"), "from the cloud");
    git(cloud, "add", "-A");
    git(cloud, "commit", "-q", "-m", "Fix");
    made.work.bundle = path.join(root, `work-${counter++}.bundle`);
    git(cloud, "bundle", "create", "-q", made.work.bundle, "refs/heads/fix-login", `^${base}`);
    made.work.save = { branch: "fix-login", head: git(cloud, "rev-parse", "HEAD"), base, bundle: true, uncommitted: true, savedAt: new Date().toISOString() };
    return { at, mac, ...made };
  }

  it("asks first only when something running would end, then brings the thread's branch", async () => {
    const { at, mac, work, asks } = await broughtSetUp();
    work.current = false;
    work.ends = ["pnpm dev"];
    expect(await mac.bringState("thread-1")).toEqual({ mac: true, can: true, ends: ["pnpm dev"] });
    expect(await mac.bring("thread-1", false)).toEqual({ confirm: ["pnpm dev"] });
    expect(asks).toEqual([]);
    expect(await mac.unbrought("cloud-1")).toEqual({ threads: 1 });
    expect(await mac.bring("thread-1", true)).toEqual({ brought: { branch: "fix-login", commits: 1, uncommitted: true } });
    expect(asks).toEqual(["thread-1"]);
    expect(git(at, "show", "fix-login:fix.txt")).toBe("from the cloud");
    expect(await mac.unbrought("cloud-1")).toEqual({ threads: 0 });
  });

  it("brings without a question when nothing would end", async () => {
    const { mac, work, asks } = await broughtSetUp();
    work.current = false;
    expect(await mac.bring("thread-1", false)).toMatchObject({ brought: { branch: "fix-login" } });
    expect(asks).toEqual(["thread-1"]);
  });

  it("brings once the save it asked for is made, though a message arriving as the thread left keeps its folder in use", async () => {
    const { mac, work, asks } = await broughtSetUp();
    work.current = false;
    work.stillInUse = true;
    expect(await mac.bring("thread-1", false)).toMatchObject({ brought: { branch: "fix-login" } });
    expect(asks).toEqual(["thread-1"]);
  });

  it("waits on a server from before `asked` until the save is current", async () => {
    const { mac, work, asks } = await broughtSetUp();
    work.current = false;
    work.asked = undefined;
    expect(await mac.bring("thread-1", false)).toMatchObject({ brought: { branch: "fix-login" } });
    expect(asks).toEqual(["thread-1"]);
  });

  it("holds Bring with why: the agent working, the folder gone, or not the thread's history", async () => {
    const { at, mac, work } = await broughtSetUp();
    work.working = true;
    expect(await mac.bringState("thread-1")).toEqual({ mac: true, can: false, reason: "The agent is still working. Bring its work once it stops." });
    work.working = false;
    work.save = { ...work.save!, base: "f".repeat(40) };
    expect(await mac.bringState("thread-1")).toEqual({ mac: true, can: false, reason: "This folder doesn't hold this thread's history, so its work can't come here." });
    rmSync(at, { recursive: true, force: true });
    expect(await mac.bringState("thread-1")).toEqual({ mac: true, can: false, reason: "The folder sketches was in isn't on this Mac anymore." });
  });

  it("says a mac project whose folder is on another Mac is held there, and a GitHub thread is not one", async () => {
    const made = account();
    made.cloud.push({ id: "cloud-1", name: "sketches", origin: "mac", defaultBranch: "main", sent: true });
    const mac = new MacProjects({ db, hosted: () => made.hosted, changed: () => {} });
    expect(await mac.bringState("thread-1")).toEqual({ mac: true, can: false, reason: "This project's folder is on another Mac." });
    made.cloud.length = 0;
    expect(await mac.bringState("thread-1")).toEqual({ mac: false });
  });
});
