import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSandboxProvider, type LocalSandbox } from "./local-sandbox.js";
import { installRunner, runnerFiles } from "./runner-client.js";
import { fillHistory, pullWorkspace, pushWorkspace, seedFromCommit, seedOverBase, seedWorkspace, type WorkspaceLocation } from "./sync.js";

const IDENTITY = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: "utf8" }).trimEnd();
}

let base: string;
let mirror: string;
let sandbox: LocalSandbox;
let location: WorkspaceLocation;

function file(root: string, name: string, content?: string): string | null {
  const full = path.join(root, name);
  if (content !== undefined) {
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "openorc-sync-"));
  mirror = path.join(base, "mac");
  mkdirSync(mirror);
  git(mirror, "init", "-q", "-b", "main");
  file(mirror, "a.txt", "a1\n");
  file(mirror, "b.txt", "b1\n");
  file(mirror, ".gitignore", "node_modules/\n");
  git(mirror, "add", "-A");
  git(mirror, "commit", "-q", "-m", "first");
  sandbox = await new LocalSandboxProvider(path.join(base, "sandboxes")).open("workspace");
  const install = await installRunner(sandbox, runnerFiles());
  location = { install, repo: path.join(sandbox.root, "repo"), mirror, refPrefix: "refs/openorc/cloud/t1/" };
});

afterEach(async () => {
  await sandbox.stop();
  await rm(base, { recursive: true, force: true });
});

describe("cloud workspace sync", () => {
  it("seeds the VM with the branch and the Mac's uncommitted work, and leaves ignored files behind", async () => {
    file(mirror, "a.txt", "a2 local\n");
    file(mirror, "c.txt", "untracked\n");
    file(mirror, "node_modules/dep.js", "ignored\n");
    await seedWorkspace(location, "main", "https://github.com/example/repo.git");
    const vm = location.repo;
    expect(git(vm, "rev-parse", "HEAD")).toBe(git(mirror, "rev-parse", "HEAD"));
    expect(git(vm, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(file(vm, "a.txt")).toBe("a2 local\n");
    expect(file(vm, "c.txt")).toBe("untracked\n");
    expect(file(vm, "node_modules/dep.js")).toBeNull();
    expect(git(vm, "status", "--porcelain")).toBe(" M a.txt\n?? c.txt");
    expect(git(vm, "remote", "get-url", "origin")).toBe("https://github.com/example/repo.git");
  });

  it("brings the VM's commits and uncommitted files to the mirror, and does nothing when nothing changed", async () => {
    file(mirror, "node_modules/dep.js", "ignored\n");
    let state = await seedWorkspace(location, "main");
    const vm = location.repo;
    file(vm, "a.txt", "a2 from cloud\n");
    rmSync(path.join(vm, "b.txt"));
    file(vm, "src/d.txt", "d\n");
    git(vm, "add", "-A");
    git(vm, "commit", "-q", "-m", "cloud commit");
    file(vm, "e.txt", "uncommitted in cloud\n");

    const pulled = await pullWorkspace(location, state);
    expect(pulled.changed).toBe(true);
    expect(pulled.keptLocalEdits).toBeNull();
    expect(pulled.branch).toBe("main");
    expect(git(mirror, "rev-parse", "HEAD")).toBe(git(vm, "rev-parse", "HEAD"));
    expect(file(mirror, "a.txt")).toBe("a2 from cloud\n");
    expect(file(mirror, "b.txt")).toBeNull();
    expect(file(mirror, "src/d.txt")).toBe("d\n");
    expect(file(mirror, "e.txt")).toBe("uncommitted in cloud\n");
    expect(file(mirror, "node_modules/dep.js")).toBe("ignored\n");
    expect(git(mirror, "status", "--porcelain")).toBe("?? e.txt");
    state = pulled.state;

    const again = await pullWorkspace(location, state);
    expect(again.changed).toBe(false);
    expect(again.state).toEqual(state);
  });

  it("keeps edits made in the mirror under a ref before the VM's version replaces them", async () => {
    const seeded = await seedWorkspace(location, "main");
    file(location.repo, "a.txt", "cloud wins\n");
    file(mirror, "a.txt", "edited on the Mac\n");
    file(mirror, "mac-only.txt", "new on the Mac\n");

    const pulled = await pullWorkspace(location, seeded);
    expect(file(mirror, "a.txt")).toBe("cloud wins\n");
    expect(file(mirror, "mac-only.txt")).toBeNull();
    expect(pulled.keptLocalEdits).toMatch(/^refs\/openorc\/cloud\/t1\/kept\/\d+$/);
    expect(git(mirror, "show", `${pulled.keptLocalEdits}:a.txt`)).toBe("edited on the Mac");
    expect(git(mirror, "show", `${pulled.keptLocalEdits}:mac-only.txt`)).toBe("new on the Mac");
  });

  it("sends only what the Mac lacks on later pulls", async () => {
    let state = await seedWorkspace(location, "main");
    file(location.repo, "big.txt", "x".repeat(200_000));
    state = (await pullWorkspace(location, state)).state;
    file(location.repo, "small.txt", "y\n");
    const result = await pullWorkspace(location, state);
    expect(file(mirror, "small.txt")).toBe("y\n");
    const bundle = await sandbox.readFile(path.join(location.install.state, "sync.bundle"));
    expect(bundle!.length).toBeLessThan(2_000);
    expect(result.changed).toBe(true);
  });
});

describe("cloud workspace sync with commits made on the Mac", () => {
  it("keeps a Mac commit the sandbox lacks under a ref when the branch follows the sandbox", async () => {
    const state = await seedWorkspace(location, "main");
    file(mirror, "mac.txt", "committed on the Mac\n");
    git(mirror, "add", "mac.txt");
    git(mirror, "commit", "-q", "-m", "mac commit");
    const macCommit = git(mirror, "rev-parse", "HEAD");
    file(location.repo, "cloud.txt", "cloud\n");
    git(location.repo, "add", "cloud.txt");
    git(location.repo, "commit", "-q", "-m", "cloud commit");

    const pulled = await pullWorkspace(location, state);
    expect(git(mirror, "rev-parse", "HEAD")).toBe(git(location.repo, "rev-parse", "HEAD"));
    expect(pulled.keptLocalCommit).toMatch(/^refs\/openorc\/cloud\/t1\/kept-commit\/\d+$/);
    expect(git(mirror, "rev-parse", pulled.keptLocalCommit!)).toBe(macCommit);
  });
});

describe("sending the Mac's changes to the sandbox", () => {
  it("brings a commit and an edit made on the Mac to the sandbox, so the next pull finds nothing to replace", async () => {
    const seeded = await seedWorkspace(location, "main");
    file(mirror, "committed.txt", "committed on the Mac\n");
    git(mirror, "add", "committed.txt");
    git(mirror, "commit", "-q", "-m", "mac commit");
    file(mirror, "a.txt", "edited on the Mac\n");

    const pushed = await pushWorkspace(location, seeded);
    expect(pushed.pushed).toBe(true);
    expect(git(location.repo, "rev-parse", "HEAD")).toBe(git(mirror, "rev-parse", "HEAD"));
    expect(file(location.repo, "committed.txt")).toBe("committed on the Mac\n");
    expect(file(location.repo, "a.txt")).toBe("edited on the Mac\n");
    expect(git(location.repo, "status", "--porcelain")).toBe(" M a.txt");

    const pulled = await pullWorkspace(location, pushed.state);
    expect(pulled).toMatchObject({ changed: false, keptLocalEdits: null, keptLocalCommit: null });
    expect(await pushWorkspace(location, pulled.state)).toMatchObject({ pushed: false });
  });

  it("sends nothing when the sandbox changed since the Mac last saw it", async () => {
    const seeded = await seedWorkspace(location, "main");
    file(location.repo, "a.txt", "changed in the cloud\n");
    file(mirror, "b.txt", "changed on the Mac\n");
    const pushed = await pushWorkspace(location, seeded);
    expect(pushed).toEqual({ state: seeded, pushed: false });
    expect(file(location.repo, "b.txt")).toBe("b1\n");
    expect(file(location.repo, "a.txt")).toBe("changed in the cloud\n");
  });
});

describe("seeding a new conversation from the commit its worktree starts at", () => {
  it("checks out that commit on the conversation's branch, and replaces a checkout an earlier attempt left", async () => {
    const commit = git(mirror, "rev-parse", "HEAD");
    file(mirror, "a.txt", "uncommitted on the Mac\n");
    const start = { source: mirror, commit, branch: "openorc/new-thread", origin: "https://github.com/example/repo.git" };
    await seedFromCommit(location, start);
    file(location.repo, "left-by-a-failed-setup.txt", "x\n");

    const state = await seedFromCommit(location, start);
    expect(state).toEqual({ snapshot: null, tree: git(mirror, "rev-parse", "HEAD^{tree}"), head: commit, known: [commit] });
    expect(git(location.repo, "symbolic-ref", "--short", "HEAD")).toBe("openorc/new-thread");
    expect(git(location.repo, "rev-parse", "HEAD")).toBe(commit);
    expect(git(location.repo, "status", "--porcelain")).toBe("");
    expect(file(location.repo, "a.txt")).toBe("a1\n");
    expect(file(location.repo, "left-by-a-failed-setup.txt")).toBeNull();
    expect(git(location.repo, "remote", "get-url", "origin")).toBe("https://github.com/example/repo.git");
  });
});

describe("a checkout seeded with its commit alone", () => {
  const commitOnMac = (name: string, content: string) => {
    file(mirror, name, content);
    git(mirror, "add", name);
    git(mirror, "commit", "-q", "-m", name);
    return git(mirror, "rev-parse", "HEAD");
  };
  const history = (repo: string, ref = "HEAD") => git(repo, "rev-list", "--count", ref);
  const shallow = (repo: string) => git(repo, "rev-parse", "--is-shallow-repository") === "true";

  it("has no history until it is filled in, syncs both ways meanwhile, and is filled once", async () => {
    commitOnMac("c.txt", "c1\n");
    const head = commitOnMac("d.txt", "d1\n");
    const state = await seedFromCommit(location, { source: mirror, commit: head, branch: "openorc/new-thread" });
    expect(shallow(location.repo)).toBe(true);
    expect(history(location.repo)).toBe("1");
    expect(git(location.repo, "status", "--porcelain")).toBe("");
    expect(file(location.repo, "c.txt")).toBe("c1\n");

    git(mirror, "checkout", "-q", "-b", "openorc/new-thread");
    file(location.repo, "e.txt", "from the cloud\n");
    const pulled = await pullWorkspace(location, state);
    expect(file(mirror, "e.txt")).toBe("from the cloud\n");
    file(mirror, "a.txt", "edited on the Mac\n");
    expect(await pushWorkspace(location, pulled.state)).toMatchObject({ pushed: true });
    expect(file(location.repo, "a.txt")).toBe("edited on the Mac\n");

    expect(await fillHistory(location, mirror)).toBe(true);
    expect(shallow(location.repo)).toBe(false);
    expect(history(location.repo, head)).toBe(history(mirror, head));
    git(location.repo, "fsck", "--connectivity-only");
    expect(await fillHistory(location, mirror)).toBe(false);
  });

  it("takes a later commit over it as commits, and one its commit cannot reach as files, and both get their history", async () => {
    const root = git(mirror, "rev-parse", "HEAD");
    const base = commitOnMac("c.txt", "c1\n");
    await seedFromCommit(location, { source: mirror, commit: base, branch: "main" });
    const later = commitOnMac("d.txt", "d1\n");

    await seedOverBase(location, { source: mirror, commit: later, branch: "openorc/later", base, shallow: true });
    expect(git(location.repo, "rev-parse", "HEAD")).toBe(later);
    expect(history(location.repo)).toBe("2");

    git(mirror, "checkout", "-q", "-b", "elsewhere", root);
    const elsewhere = commitOnMac("f.txt", "f1\n");
    await seedOverBase(location, { source: mirror, commit: elsewhere, branch: "openorc/elsewhere", base, shallow: true });
    expect(git(location.repo, "rev-parse", "HEAD")).toBe(elsewhere);
    expect(git(location.repo, "status", "--porcelain")).toBe("");
    expect(file(location.repo, "c.txt")).toBeNull();
    expect(file(location.repo, "f.txt")).toBe("f1\n");

    expect(await fillHistory(location, mirror)).toBe(true);
    expect(shallow(location.repo)).toBe(false);
    expect(history(location.repo, elsewhere)).toBe("2");
    expect(history(location.repo, later)).toBe("3");
  });
});
