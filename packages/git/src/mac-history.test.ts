import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MAC_FILE_BYTES } from "./mac-start.js";
import { BringRefused, bringIntoFolder, macHistory, NOT_THAT_FOLDER, packMacHistory } from "./mac-history.js";

const root = mkdtempSync(path.join(os.tmpdir(), "openorc-mac-history-test-"));
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

/** A folder with no remote and two commits on main. */
function folder(name: string) {
  const at = path.join(root, name);
  git(root, "init", "-q", "-b", "main", at);
  writeFileSync(path.join(at, "a.txt"), "first");
  git(at, "add", "-A");
  git(at, "commit", "-q", "-m", "First");
  writeFileSync(path.join(at, "b.txt"), "second");
  git(at, "add", "-A");
  git(at, "commit", "-q", "-m", "Second");
  return at;
}

/** The cloud's copy of `mac`, a thread's branch on it with one commit, and that branch's save bundle beyond the base. */
function cloudWork(mac: string, name: string, branch = "fix-login") {
  const cloud = path.join(root, `${name}-cloud`);
  git(root, "clone", "-q", mac, cloud);
  const base = git(cloud, "rev-parse", "HEAD");
  git(cloud, "checkout", "-q", "-B", branch);
  writeFileSync(path.join(cloud, "fix.txt"), "from the cloud");
  git(cloud, "add", "-A");
  git(cloud, "commit", "-q", "-m", "Fix the login");
  const bundle = path.join(root, `${name}.bundle`);
  git(cloud, "bundle", "create", "-q", bundle, `refs/heads/${branch}`, `^${base}`);
  return { bundle, base, head: git(cloud, "rev-parse", "HEAD") };
}

describe("a folder's history for its cloud project", () => {
  it("packs its branch with all its history and no prerequisite, the folder untouched", async () => {
    const at = folder("plain");
    const pack = await packMacHistory(at, "plain");
    if (!("file" in pack)) throw new Error(pack.refusal ?? "no pack");
    expect(pack).toMatchObject({ branch: "main", head: git(at, "rev-parse", "HEAD"), refusal: null });
    const heads = git(at, "bundle", "list-heads", pack.file);
    expect(heads).toBe(`${pack.head} refs/heads/main`);
    expect(git(at, "bundle", "verify", pack.file)).not.toContain("requires");
    expect(git(at, "status", "--porcelain")).toBe("");
  });

  it("refuses a history holding a file over the limit, naming it, though the folder no longer has it", async () => {
    const at = folder("large");
    writeFileSync(path.join(at, "intro.mov"), Buffer.alloc(MAC_FILE_BYTES + 1024 * 1024, 7));
    git(at, "add", "-A");
    git(at, "commit", "-q", "-m", "Video");
    git(at, "rm", "-q", "intro.mov");
    git(at, "commit", "-q", "-m", "No video");
    expect((await macHistory(at, "large")).refusal).toBe("Too large to send from this Mac: intro.mov (51 MB) in its history, over 50 MB each.");
    expect(await packMacHistory(at, "large")).not.toHaveProperty("file");
  }, 60_000);

  it("says in words when no branch is checked out", async () => {
    const at = folder("detached");
    git(at, "checkout", "-q", "--detach");
    await expect(macHistory(at, "detached")).rejects.toThrow("Check out a branch in this folder first.");
  });
});

describe("a thread's work brought to the folder", () => {
  it("comes as the thread's branch, checked, the working tree, index and checked-out branch untouched, and again as nothing new", async () => {
    const mac = folder("bring");
    writeFileSync(path.join(mac, "local.txt"), "uncommitted here");
    const { bundle, base, head } = cloudWork(mac, "bring");
    expect(await bringIntoFolder(mac, bundle, { branch: "fix-login", head, base })).toEqual({ branch: "fix-login", commits: 1 });
    expect(git(mac, "rev-parse", "refs/heads/fix-login")).toBe(head);
    expect(git(mac, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(mac, "status", "--porcelain")).toBe("?? local.txt");
    expect(git(mac, "for-each-ref", "refs/openorc"), "nothing left waiting").toBe("");
    expect(await bringIntoFolder(mac, bundle, { branch: "fix-login", head, base })).toEqual({ branch: "fix-login", commits: 0 });
  });

  it("counts only the commits no branch here had, as a commit the Mac sent with the thread's start", async () => {
    const mac = folder("counted");
    const base = git(mac, "rev-parse", "HEAD");
    writeFileSync(path.join(mac, "mac.txt"), "sent with the start");
    git(mac, "add", "-A");
    git(mac, "commit", "-q", "-m", "On the Mac");
    const cloud = path.join(root, "counted-cloud");
    git(root, "clone", "-q", mac, cloud);
    git(cloud, "checkout", "-q", "-B", "fix-login");
    writeFileSync(path.join(cloud, "fix.txt"), "from the cloud");
    git(cloud, "add", "-A");
    git(cloud, "commit", "-q", "-m", "Fix the login");
    const bundle = path.join(root, "counted.bundle");
    git(cloud, "bundle", "create", "-q", bundle, "refs/heads/fix-login", `^${base}`);
    expect(await bringIntoFolder(mac, bundle, { branch: "fix-login", head: git(cloud, "rev-parse", "HEAD"), base })).toEqual({ branch: "fix-login", commits: 1 });
  });

  it("leaves a branch of that name with other work alone, and the branch checked out, and comes beside them", async () => {
    const mac = folder("beside");
    const { bundle, base, head } = cloudWork(mac, "beside", "main");
    // The thread's branch is the one checked out here: never moved under the person.
    expect(await bringIntoFolder(mac, bundle, { branch: "main", head, base })).toEqual({ branch: "main-2", commits: 1 });
    git(mac, "branch", "-q", "other", base);
    git(mac, "checkout", "-q", "other");
    writeFileSync(path.join(mac, "mine.txt"), "mine");
    git(mac, "add", "-A");
    git(mac, "commit", "-q", "-m", "Mine");
    git(mac, "checkout", "-q", "main");
    const again = cloudWork(mac, "beside-again", "other");
    expect((await bringIntoFolder(mac, again.bundle, { branch: "other", head: again.head, base: again.base })).branch).toBe("other-2");
  });

  it("never takes a name git could read as an option, or that is no branch's", async () => {
    const mac = folder("named");
    const { bundle, base, head } = cloudWork(mac, "named");
    expect((await bringIntoFolder(mac, bundle, { branch: "--upload-pack=touch /tmp/x", head, base })).branch).toBe(`openorc/${head.slice(0, 7)}`);
    expect((await bringIntoFolder(mac, bundle, { branch: "bad..name", head, base })).branch).toBe(`openorc/${head.slice(0, 7)}`);
  });

  it("refuses a folder that doesn't hold the thread's history", async () => {
    const mac = folder("source");
    const { bundle, base, head } = cloudWork(mac, "source");
    const stranger = path.join(root, "stranger");
    git(root, "init", "-q", "-b", "main", stranger);
    writeFileSync(path.join(stranger, "other.txt"), "another project");
    git(stranger, "add", "-A");
    git(stranger, "commit", "-q", "-m", "Another project");
    await expect(bringIntoFolder(stranger, bundle, { branch: "fix-login", head, base })).rejects.toThrow(new BringRefused(NOT_THAT_FOLDER));
  });
});
