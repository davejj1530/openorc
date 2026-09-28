import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, GitError } from "./exec.js";
import { commitAll } from "./publish.js";
import { patchAgainst } from "./repo.js";

let root: string;
let base: string;

/** How untracked files were rendered before they shared one git call: one `diff --no-index` per file. */
async function perFileUntracked(cwd: string): Promise<string[]> {
  const files = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean);
  const out: string[] = [];
  for (const file of files) {
    const s = await stat(path.join(cwd, file));
    if (!s.isFile() || s.size > 1024 * 1024) continue;
    const r = await git(cwd, ["diff", "--no-color", "--no-index", "--", "/dev/null", file], { okCodes: [0, 1] });
    out.push(r.stdout.replace(/^diff --git a\/dev\/null b\/.*$/m, `diff --git a/${file} b/${file}`).replace(/^\+\+\+ b\/.*$/m, `+++ b/${file}`));
  }
  return out;
}

const chunks = (patch: string) => patch.split(/^(?=diff --git )/m).filter((c) => c.trim());

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-patch-"));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(path.join(root, ".gitignore"), "ignored/\n");
  await writeFile(path.join(root, "tracked.txt"), "one\n");
  base = await commitAll(root, "init");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("patchAgainst", () => {
  it("renders untracked files exactly as one diff per file did, after the tracked changes", async () => {
    await writeFile(path.join(root, "tracked.txt"), "one\ntwo\n");
    await writeFile(path.join(root, "plain.txt"), "hello\n");
    await writeFile(path.join(root, "with space.txt"), "spaced\n");
    await writeFile(path.join(root, "é-accent.txt"), "accent\n");
    await writeFile(path.join(root, "empty.txt"), "");
    await writeFile(path.join(root, "run.sh"), "#!/bin/sh\necho hi\n");
    await chmod(path.join(root, "run.sh"), 0o755);
    await mkdir(path.join(root, "nested", "deeper"), { recursive: true });
    await writeFile(path.join(root, "nested", "deeper", "file.ts"), "export const x = 1;\n");
    await mkdir(path.join(root, "ignored"));
    await writeFile(path.join(root, "ignored", "skip.txt"), "never shown\n");
    await writeFile(path.join(root, "big.bin"), Buffer.alloc(1024 * 1024 + 1, 97));

    const patch = await patchAgainst(root, base);
    const [tracked, ...untracked] = chunks(patch);
    expect(tracked).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(tracked).toContain("+two");
    // Git ends a +++ name containing spaces with a tab, as it does for tracked files; the per-file path rewrote that line without it.
    const normalized = (c: string) => c.replace(/^(\+\+\+ .*)\t$/m, "$1").trimEnd();
    expect(untracked.filter((c) => !c.includes("large file omitted")).map(normalized)).toEqual((await perFileUntracked(root)).map(normalized));
    expect(untracked.find((c) => c.startsWith("diff --git a/big.bin b/big.bin"))).toContain("+[large file omitted]");
    expect(patch).not.toContain("skip.txt");
  });

  it("returns only the tracked diff when nothing is untracked", async () => {
    await writeFile(path.join(root, "tracked.txt"), "changed\n");
    expect(chunks(await patchAgainst(root, base))).toHaveLength(1);
  });
});

it("keeps an untracked file's executable bit when git ignores file modes", async () => {
  await git(root, ["config", "core.filemode", "false"]);
  await writeFile(path.join(root, "run.sh"), "#!/bin/sh\necho hi\n");
  await chmod(path.join(root, "run.sh"), 0o755);
  expect(await patchAgainst(root, base)).toContain("diff --git a/run.sh b/run.sh\nnew file mode 100755");
});

// A path list larger than the pipe buffer, sent to a git that exits without reading it, must fail like any git error.
it("rejects instead of crashing when git exits before reading a large stdin", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "openorc-not-a-repo-"));
  try {
    // The ceiling keeps git from finding a repository above the temp folder, which would make it read the input first.
    const env = { GIT_CEILING_DIRECTORIES: path.dirname(outside) };
    await expect(git(outside, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: "x".repeat(512 * 1024), env })).rejects.toBeInstanceOf(GitError);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
