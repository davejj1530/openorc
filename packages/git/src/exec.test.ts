import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { git, gitToFile, run } from "./exec.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-git-exec-"));
  await git(root, ["init", "-q"]);
  await writeFile(path.join(root, "a.txt"), "hello\n");
  await git(root, ["add", "a.txt"]);
  await git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "init"]);
});

afterEach(() => rm(root, { recursive: true, force: true }));

it("writes a pack to a file as git makes it, from its input, so another repository can index it", async () => {
  const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const objects = (await git(root, ["rev-list", "--objects", "--no-object-names", "--max-count=1", head])).stdout;
  const pack = path.join(root, "..", `${path.basename(root)}.pack`);
  await gitToFile(root, ["pack-objects", "-q", "--stdout"], pack, { input: objects });

  const other = await mkdtemp(path.join(os.tmpdir(), "openorc-git-exec-other-"));
  try {
    await git(other, ["init", "-q"]);
    await run("sh", other, ["-c", 'git index-pack --stdin < "$0"', pack]);
    expect((await git(other, ["cat-file", "-t", head])).stdout.trim()).toBe("commit");
  } finally {
    await rm(other, { recursive: true, force: true });
    await rm(pack, { force: true });
  }
});

it("says why git failed", async () => {
  await expect(gitToFile(root, ["cat-file", "-p", "no-such-object"], path.join(root, "out"))).rejects.toThrow(/git cat-file -p no-such-object failed \(128\).*no-such-object/s);
});
