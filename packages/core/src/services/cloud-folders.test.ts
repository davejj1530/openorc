import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Db, projects } from "@openorc/db";
import type { Hosted } from "@openorc/hosted";
import { computerNames, HOSTED_REASONS } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CloudFolders } from "./cloud-folders.js";

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
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const ID = "cloud-thread-1";

let root: string;
let db: Db;
let folder: string;
let projectId: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-folders-")));
  db = Db.memory();
  folder = path.join(root, "app");
  git(root, "init", "-q", "-b", "main", folder);
  await writeFile(path.join(folder, "README.md"), "# app\n");
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", "First");
  projectId = projects.insert(db, { name: "App", rootPath: folder, gitRemote: null, defaultBranch: "main", settings: {} }).id;
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

/** A save of the thread's work in the cloud with `text` in FIX.md: its commit, and its bundle beyond the base. */
function cloudSave(text: string, savedAt: string) {
  const cloud = path.join(root, `cloud-${savedAt.replace(/\W/g, "")}`);
  git(root, "clone", "-q", folder, cloud);
  const base = git(cloud, "rev-parse", "HEAD");
  git(cloud, "checkout", "-q", "-b", "openorc/fix");
  execFileSync("sh", ["-c", `printf '%s' "$0" > FIX.md`, text], { cwd: cloud });
  git(cloud, "add", "-A");
  git(cloud, "commit", "-q", "-m", "Fix");
  const bundle = path.join(root, `${path.basename(cloud)}.bundle`);
  git(cloud, "bundle", "create", "-q", bundle, "refs/heads/openorc/fix", `^${base}`);
  return { save: { branch: "openorc/fix", head: git(cloud, "rev-parse", "HEAD"), base, bundle: true, uncommitted: false, savedAt }, bundle };
}

/**
 * The thread's machine as the server tells of it: its saves, whether the newest is current, and how it answers an ask
 * to leave with a save (`refuse` as a running turn or a reader who may not refuses it).
 */
function machine(options: { current: boolean; refuse?: boolean; ends?: string[]; writes?: boolean }) {
  const saves = [cloudSave("first", "2026-11-18T10:00:00.000Z")];
  let current = options.current;
  const asked = { reads: 0, asks: 0 };
  const written: { path: string; text: string | null }[] = [];
  const hosted = {
    threads: {
      holds: ({ thread }: { thread: string }) => thread === ID,
      row: () => ({ id: ID, space: "personal" }),
      summary: () => ({ id: ID, projectId }),
      call: async () => ({ version: 1, features: options.writes ? { fileWrite: { available: true } } : {} }),
      written,
      // A method of its place, as the hosted package's is: called off its object it has no place to write through.
      async writeFile(this: { written: typeof written }, _: string, write: { path: string; text: string | null }) {
        this.written.push(write);
        return {
          kind: "saved",
          version: createHash("sha256")
            .update(write.text ?? "")
            .digest("hex"),
        };
      },
    },
    macProjects: {
      workSave: async () => {
        asked.reads += 1;
        return { save: saves.at(-1)!.save, current, working: false, ends: current ? [] : (options.ends ?? []) };
      },
      bundle: async () => new Response(await readFile(saves.at(-1)!.bundle)),
      ask: async () => {
        asked.asks += 1;
        if (options.refuse) throw new Error("A turn is running.");
        saves.push(cloudSave("second", "2026-11-18T10:05:00.000Z"));
        current = true;
        return { asked: true };
      },
    },
  } as unknown as Hosted;
  let now = Date.parse("2026-11-18T11:00:00.000Z");
  const folders = new CloudFolders({ db, hosted: () => hosted, dataDir: root, invalidate: () => {}, here: computerNames(process.platform), now: () => now });
  return { folders, asked, written, later: (ms: number) => void (now += ms) };
}

const fix = async (root: string) => readFile(path.join(root, "FIX.md"), "utf8");

it("reads a cloud thread's files from a copy of its work, read-only, and any other conversation's from its folder here", async () => {
  const { folders } = machine({ current: true });
  const cloud = await folders.of({ kind: "thread", id: ID });
  expect(cloud).toMatchObject({ root: path.join(root, "cloud-copies", ID), kind: "cloud", readOnly: HOSTED_REASONS.fileWrite, name: "app" });
  expect(await fix(cloud.root)).toBe("first");
  expect(await readFile(path.join(cloud.root, "README.md"), "utf8")).toBe("# app\n");
  await expect(folders.of({ kind: "project", id: projectId })).resolves.toMatchObject({ root: folder, kind: "checkout" });
});

it("never asks the machine anything on a read, as when a turn runs there: the last save stands, and is read again after a while", async () => {
  const { folders, asked, later } = machine({ current: false });
  expect(await fix((await folders.of({ kind: "thread", id: ID })).root)).toBe("first");
  const reads = asked.reads;
  // A listing's many reads read the copy as it is.
  await folders.of({ kind: "thread", id: ID });
  expect(asked.reads).toBe(reads);
  later(31_000);
  await folders.of({ kind: "thread", id: ID });
  expect([asked.reads, asked.asks]).toEqual([reads + 1, 0]);
});

it("never ends what runs on the machine for a read, and Refresh names it and asks only once the person says so", async () => {
  const { folders, asked, later } = machine({ current: false, ends: ["The terminal running npm run dev"] });
  for (let read = 0; read < 3; read += 1) {
    expect(await fix((await folders.of({ kind: "thread", id: ID })).root)).toBe("first");
    later(31_000);
  }
  expect(asked.asks).toBe(0);
  expect(await folders.refresh(ID, false)).toEqual({ confirm: ["The terminal running npm run dev"] });
  expect(asked.asks).toBe(0);
  const refreshed = await folders.refresh(ID, true);
  expect(asked.asks).toBe(1);
  expect("copy" in refreshed && (await fix(refreshed.copy.folder))).toBe("second");
});

it("writes a cloud thread's file on its machine once its server writes them, and the copy holds the write at once", async () => {
  const { folders, written } = machine({ current: true, writes: true });
  const folder = await folders.of({ kind: "thread", id: ID });
  expect(folder.readOnly).toBeNull();
  const saved = await folders.write(ID, folder, { path: "FIX.md" as never, text: "mine", expected: { kind: "absent" } });
  expect(saved).toMatchObject({ kind: "saved", path: "FIX.md", absolutePath: path.join(folder.root, "FIX.md") });
  expect(written).toEqual([expect.objectContaining({ path: "FIX.md", text: "mine" })]);
  expect(await fix(folder.root)).toBe("mine");
});
