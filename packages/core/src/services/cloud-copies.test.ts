import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Db, projects } from "@openorc/db";
import type { Hosted } from "@openorc/hosted";
import { computerNames } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloudCopies } from "./cloud-copies.js";

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

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-copies-")));
  db = Db.memory();
  folder = path.join(root, "app");
  git(root, "init", "-q", "-b", "main", folder);
  await writeFile(path.join(folder, "README.md"), "# app\n");
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", "First");
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

/** The thread's save in the cloud, made again with `text` in FIX.md: its commit and its bundle beyond the base. */
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

/** A signed-in account holding the thread, whose project is `folder` here (or none here), its newest save as `saves` say. */
function account(saves: ReturnType<typeof cloudSave>[], here = true) {
  const project = here ? projects.insert(db, { name: "App", rootPath: folder, gitRemote: null, defaultBranch: "main", settings: {} }) : { id: "cloud:elsewhere" };
  const asked = { bundles: 0, reads: 0 };
  const hosted = {
    threads: {
      holds: ({ thread }: { thread: string }) => thread === ID,
      row: () => ({ id: ID, space: "personal" }),
      summary: () => ({ id: ID, projectId: project.id }),
      // The server's own projects: none this computer has no folder of.
      project: () => null,
    },
    macProjects: {
      workSave: async () => {
        asked.reads += 1;
        return { save: saves.at(-1)?.save ?? null, current: true, working: false, ends: [] };
      },
      bundle: async () => {
        asked.bundles += 1;
        return new Response(await readFile(saves.at(-1)!.bundle));
      },
    },
  } as unknown as Hosted;
  return { hosted, asked };
}

function copies(hosted: Hosted, invalidated: string[][] = []) {
  return new CloudCopies({ db, hosted: () => hosted, dataDir: path.join(root, "data"), invalidate: (keys) => invalidated.push(keys), here: computerNames("darwin") });
}

describe("a cloud thread's code read on this computer", () => {
  it("is a copy of its newest save in one folder for the thread, made once while the save stays, and once for reads asked together", async () => {
    const saves = [cloudSave("first fix\n", "2026-11-18T01:00:00.000Z")];
    const { hosted, asked } = account(saves);
    const invalidated: string[][] = [];
    const service = copies(hosted, invalidated);
    const [one, two] = await Promise.all([service.ensure(ID), service.ensure(ID)]);
    expect(one).toEqual(two);
    expect(one).toEqual({
      folder: path.join(root, "data", "cloud-copies", ID),
      savedAt: "2026-11-18T01:00:00.000Z",
      head: saves[0]!.save.head,
      asOf: { turnId: null, at: "2026-11-18T01:00:00.000Z" },
    });
    expect(await readFile(path.join(one.folder, "FIX.md"), "utf8")).toBe("first fix\n");
    expect(asked.bundles).toBe(1);
    expect(invalidated).toEqual([["files", "workspace-diff"]]);
    expect(await service.ensure(ID)).toEqual(one);
    expect(asked.bundles).toBe(1);
  });

  it("is made again in the same folder once the save moves on, and waits for a newer save when asked for one", async () => {
    const saves = [cloudSave("first fix\n", "2026-11-18T01:00:00.000Z")];
    const { hosted } = account(saves);
    const service = copies(hosted);
    const first = await service.ensure(ID);
    const newer = service.ensure(ID, { after: first.savedAt });
    setTimeout(() => saves.push(cloudSave("second fix\n", "2026-11-18T02:00:00.000Z")), 200);
    const second = await newer;
    expect(second.folder).toBe(first.folder);
    expect(second.savedAt).toBe("2026-11-18T02:00:00.000Z");
    expect(await readFile(path.join(second.folder, "FIX.md"), "utf8")).toBe("second fix\n");
  });

  it("lays a write the person made into the copy at once, and keeps it until the next save", async () => {
    const saves = [cloudSave("first fix\n", "2026-11-18T01:00:00.000Z")];
    const { hosted, asked } = account(saves);
    const invalidated: string[][] = [];
    const service = copies(hosted, invalidated);
    const copy = await service.ensure(ID);
    await service.applyWrite(ID, "src/new.ts", new TextEncoder().encode("export {};\n"));
    await service.applyWrite(ID, "FIX.md", null);
    expect(await readFile(path.join(copy.folder, "src/new.ts"), "utf8")).toBe("export {};\n");
    await expect(readFile(path.join(copy.folder, "FIX.md"))).rejects.toThrow();
    const after = await service.ensure(ID);
    expect(after.asOf.turnId).toBeNull();
    expect(after.asOf.at).not.toBe(copy.savedAt);
    expect(asked.bundles).toBe(1);
    expect(invalidated.at(-1)).toEqual(["files", "workspace-diff"]);
    await expect(service.applyWrite(ID, "../outside.txt", new Uint8Array())).rejects.toThrow("That file isn't in the thread's folder.");
  });

  it("says why when the thread has no save yet", async () => {
    const { hosted } = account([]);
    await expect(copies(hosted).ensure(ID)).rejects.toThrow("This thread hasn't saved its work yet.");
  });

  it("says why when the thread's project isn't on this computer", async () => {
    const { hosted } = account([cloudSave("first fix\n", "2026-11-18T01:00:00.000Z")], false);
    await expect(copies(hosted).ensure(ID)).rejects.toThrow("This project isn't on this Mac.");
  });
});
