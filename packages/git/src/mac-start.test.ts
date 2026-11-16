import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MAC_FILE_BYTES, packMacWork } from "./mac-start.js";

const root = mkdtempSync(path.join(os.tmpdir(), "openorc-mac-start-test-"));
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

/** A folder cloned from its "GitHub", with a commit ahead, an edit, a new file, an ignored file and a secret-looking one. */
function folder(name: string) {
  const origin = path.join(root, `${name}-origin.git`);
  const seed = path.join(root, `${name}-seed`);
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, seed);
  writeFileSync(path.join(seed, "README.md"), "base");
  writeFileSync(path.join(seed, ".gitignore"), "ignored.txt\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "Base");
  git(seed, "push", "-q", "origin", "main");
  const mac = path.join(root, `${name}-mac`);
  git(root, "clone", "-q", origin, mac);
  writeFileSync(path.join(mac, "AHEAD.md"), "a commit GitHub lacks");
  git(mac, "add", "AHEAD.md");
  git(mac, "commit", "-q", "-m", "Ahead of GitHub");
  writeFileSync(path.join(mac, "README.md"), "edited here");
  writeFileSync(path.join(mac, "NEW.md"), "new here");
  writeFileSync(path.join(mac, "ignored.txt"), "IGNORED-CONTENT-7c1");
  writeFileSync(path.join(mac, ".env.local"), "HELD-CONTENT-93a");
  return { mac, origin };
}

/** Every object a bundle carries with GitHub's base, its blobs' contents read, in a repository of its own; and the files' commit's paths. */
function unpacked(file: string, origin: string) {
  const repo = path.join(root, `unpacked-${Date.now()}-${Math.random()}`);
  // The bundle builds on GitHub's base, which a copy of GitHub's repository has.
  git(root, "clone", "-q", "--bare", origin, repo);
  git(repo, "fetch", "-q", file, "refs/*:refs/*");
  const blobs = execFileSync("git", ["cat-file", "--batch-all-objects", "--batch"], { cwd: repo, env, maxBuffer: 256 * 1024 * 1024 }).toString("latin1");
  return { blobs, paths: git(repo, "ls-tree", "-r", "--name-only", "refs/openorc/saved/wip").split("\n") };
}

describe("a folder's work for a cloud thread", () => {
  it("says what goes, commits ahead included, and carries no byte of an ignored file or a held-back one", async () => {
    const { mac, origin } = folder("plain");
    const pack = await packMacWork(mac, { baseRef: "refs/remotes/origin/main" });
    expect(pack.commits.map((one) => one.subject)).toEqual(["Ahead of GitHub"]);
    expect(pack.changed).toEqual(["README.md"]);
    expect(pack.added).toEqual(["NEW.md"]);
    expect(pack.held).toEqual([".env.local"]);
    expect(pack.refusal).toBeNull();
    expect(pack.bytes).toBeGreaterThan(0);
    const { blobs, paths } = unpacked(pack.file, origin);
    expect(blobs).toContain("a commit GitHub lacks");
    expect(blobs).toContain("edited here");
    expect(blobs).toContain("new here");
    expect(blobs).not.toContain("IGNORED-CONTENT-7c1");
    expect(blobs).not.toContain("HELD-CONTENT-93a");
    expect(paths).not.toContain("ignored.txt");
    expect(paths).not.toContain(".env.local");
    // The folder itself is as it was: nothing staged, no ref left.
    expect(git(mac, "status", "--porcelain")).toContain("?? .env.local");
    expect(git(mac, "for-each-ref", "refs/openorc")).toBe("");
    expect(pack.query.base).toBe(git(mac, "rev-parse", "origin/main"));
    expect(pack.query.headSha).toBe(git(mac, "rev-parse", "HEAD"));
  });

  it("sends a held-back file the person includes", async () => {
    const { mac, origin } = folder("included");
    const pack = await packMacWork(mac, { baseRef: "refs/remotes/origin/main", include: [".env.local"] });
    expect(pack.held).toEqual([]);
    expect(pack.added).toEqual([".env.local", "NEW.md"]);
    expect(unpacked(pack.file, origin).blobs).toContain("HELD-CONTENT-93a");
  });

  it("refuses a file over its size, naming it", async () => {
    const { mac } = folder("large");
    writeFileSync(path.join(mac, "video.bin"), Buffer.alloc(MAC_FILE_BYTES + 1024 * 1024, 7));
    const pack = await packMacWork(mac, { baseRef: "refs/remotes/origin/main" });
    expect(pack.refusal).toBe("Too large to send from this Mac: video.bin (51 MB), over 50 MB each.");
    expect(pack.largest[0]).toEqual({ path: "video.bin", bytes: MAC_FILE_BYTES + 1024 * 1024 });
  }, 60_000);

  it("says so in words when the folder shares no history with its base", async () => {
    const lone = path.join(root, "lone");
    git(root, "init", "-q", "-b", "main", lone);
    writeFileSync(path.join(lone, "a.txt"), "a");
    git(lone, "add", "-A");
    git(lone, "commit", "-q", "-m", "a");
    await expect(packMacWork(lone, { baseRef: "refs/remotes/origin/main" })).rejects.toThrow("This folder shares no history with origin/main. Fetch it, then try again.");
  });
});
