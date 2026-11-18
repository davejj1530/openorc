import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeReadingCopy, START_NOT_HERE, StartUnreachable } from "./reading-copy.js";

const root = mkdtempSync(path.join(os.tmpdir(), "openorc-reading-copy-test-"));
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
// The store's fetches run this process's own git: none of the person's settings or sign-ins.
Object.assign(process.env, { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

/** The project's folder here, one commit on main. */
function project(name: string) {
  const at = path.join(root, name);
  git(root, "init", "-q", "-b", "main", at);
  writeFileSync(path.join(at, "README.md"), "# app\n");
  git(at, "add", "-A");
  git(at, "commit", "-q", "-m", "First");
  return at;
}

/** A thread's save in the cloud: a commit on its branch, an edit and a new file not committed, and the bundle beyond the base. */
function save(from: string, name: string) {
  const cloud = path.join(root, `${name}-cloud`);
  git(root, "clone", "-q", from, cloud);
  const base = git(cloud, "rev-parse", "HEAD");
  git(cloud, "checkout", "-q", "-b", "openorc/fix-login");
  writeFileSync(path.join(cloud, "FIX.md"), "committed in the cloud\n");
  git(cloud, "add", "-A");
  git(cloud, "commit", "-q", "-m", "Fix");
  const head = git(cloud, "rev-parse", "HEAD");
  writeFileSync(path.join(cloud, "README.md"), "# app\nedited, not committed\n");
  writeFileSync(path.join(cloud, "NEW.md"), "new, not committed\n");
  const index = { ...env, GIT_INDEX_FILE: path.join(root, `${name}-index`) };
  execFileSync("git", ["read-tree", "HEAD"], { cwd: cloud, env: index });
  execFileSync("git", ["add", "-A"], { cwd: cloud, env: index });
  const tree = execFileSync("git", ["write-tree"], { cwd: cloud, env: index, encoding: "utf8" }).trim();
  git(cloud, "update-ref", "refs/openorc/saved/wip", git(cloud, "commit-tree", tree, "-p", "HEAD", "-m", "wip"));
  const bundle = path.join(root, `${name}.bundle`);
  git(cloud, "bundle", "create", "-q", bundle, "refs/openorc/saved/wip", "refs/heads/openorc/fix-login", `^${base}`);
  return { base, head, bundle };
}

describe("a reading copy of a cloud thread's work save", () => {
  it("holds its files as the save left them, what it hadn't committed included, on its newest commit", async () => {
    const app = project("app");
    const saved = save(app, "app");
    const to = path.join(root, "copies", "thread-1");
    execFileSync("mkdir", ["-p", path.dirname(to)]);
    await makeReadingCopy({ folder: app }, to, saved, saved.bundle);
    expect(readFileSync(path.join(to, "FIX.md"), "utf8")).toBe("committed in the cloud\n");
    expect(readFileSync(path.join(to, "README.md"), "utf8")).toBe("# app\nedited, not committed\n");
    expect(git(to, "rev-parse", "HEAD")).toBe(saved.head);
    expect(git(to, "status", "--porcelain")).toBe("M README.md\n?? NEW.md");
    // The project's folder is left as it was: no branch, no ref of the thread's.
    expect(git(app, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
  });

  it("is its start as it was when the save has no commits of its own, and is made again in place", async () => {
    const app = project("start");
    const base = git(app, "rev-parse", "HEAD");
    const to = path.join(root, "copies", "thread-2");
    execFileSync("mkdir", ["-p", path.dirname(to)]);
    await makeReadingCopy({ folder: app }, to, { head: base, base }, null);
    writeFileSync(path.join(to, "LEFT.md"), "from the copy before\n");
    await makeReadingCopy({ folder: app }, to, { head: base, base }, null);
    expect(readFileSync(path.join(to, "README.md"), "utf8")).toBe("# app\n");
    expect(existsSync(path.join(to, "LEFT.md"))).toBe(false);
    expect(git(to, "status", "--porcelain")).toBe("");
  });

  it("says so when the project's folder doesn't hold the thread's start", async () => {
    const app = project("elsewhere");
    const to = path.join(root, "copies", "thread-3");
    await expect(makeReadingCopy({ folder: app }, to, { head: "1".repeat(40), base: "1".repeat(40) }, null)).rejects.toThrow(START_NOT_HERE);
    expect(existsSync(to)).toBe(false);
  });
});

describe("a reading copy of a project with no folder here", () => {
  /** The project's repository as GitHub serves it: commits before its start, which a store never needs. */
  function repository(name: string) {
    const at = project(name);
    for (const n of [2, 3]) {
      writeFileSync(path.join(at, `HISTORY-${n}.md`), `${n}\n`);
      git(at, "add", "-A");
      git(at, "commit", "-q", "-m", `More ${n}`);
    }
    git(at, "config", "uploadpack.allowReachableSHA1InWant", "true");
    return at;
  }

  it("fetches only the save's start from the repository into its store, and lays the save over it", async () => {
    const remote = repository("hub");
    const saved = save(remote, "hub");
    const store = path.join(root, "starts", "hub.git");
    const to = path.join(root, "copies", "thread-4");
    execFileSync("mkdir", ["-p", path.dirname(to)]);
    await makeReadingCopy({ store, remote: `file://${remote}` }, to, saved, saved.bundle);
    expect(readFileSync(path.join(to, "FIX.md"), "utf8")).toBe("committed in the cloud\n");
    expect(git(to, "status", "--porcelain")).toBe("M README.md\n?? NEW.md");
    // The start alone, none of the history before it, kept by a ref of the store's own.
    expect(git(store, "rev-list", "--all", "--count")).toBe("1");
    expect(git(store, "for-each-ref", "--format=%(refname)")).toBe(`refs/starts/${saved.base}`);
    // A second copy from the same start fetches nothing: the repository is gone and it is still made.
    rmSync(remote, { recursive: true, force: true });
    await makeReadingCopy({ store, remote: `file://${remote}` }, `${to}-again`, saved, saved.bundle);
    expect(readFileSync(path.join(`${to}-again`, "FIX.md"), "utf8")).toBe("committed in the cloud\n");
  });

  it("says why a start can't be fetched: the repository unreachable, not readable with this sign-in, or without the commit", async () => {
    const reason = (remote: string, base = "1".repeat(40)) =>
      makeReadingCopy({ store: path.join(root, "starts", `${base}-${remote.length}.git`), remote }, path.join(root, "copies", "unfetched"), { head: base, base }, null).then(
        () => null,
        (error: unknown) => (error instanceof StartUnreachable ? error.reason : error),
      );
    // Nothing answers there.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    expect(await reason(`http://127.0.0.1:${port}/team/app.git`)).toBe("offline");
    // GitHub's answer to a sign-in that may not read the repository.
    const signIn = createServer((_, response) => response.writeHead(401, { "WWW-Authenticate": 'Basic realm="GitHub"' }).end());
    await new Promise<void>((resolve) => signIn.listen(0, "127.0.0.1", resolve));
    try {
      expect(await reason(`http://127.0.0.1:${(signIn.address() as AddressInfo).port}/team/app.git`)).toBe("access");
    } finally {
      await new Promise((resolve) => signIn.close(resolve));
    }
    // The repository no longer has the commit.
    expect(await reason(`file://${repository("rewritten")}`)).toBe("gone");
    expect(existsSync(path.join(root, "copies", "unfetched"))).toBe(false);
  });
});
