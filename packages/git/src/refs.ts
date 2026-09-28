import { git } from "./exec.js";

const OWN = "refs/openorc/";

function own(ref: string): void {
  if (!ref.startsWith(OWN) || ref.includes("..") || /[\s~^:?*[\\]/.test(ref)) throw new Error(`OpenOrc keeps its objects only under ${OWN}: ${ref}`);
}

/**
 * Keeps an object that no branch reaches, such as a checkpoint's tree, from being removed by `git gc`. Refs live in
 * the repository's shared directory, so a ref made from a worktree protects the object for every worktree.
 */
export async function pinObject(cwd: string, ref: string, oid: string): Promise<void> {
  own(ref);
  await git(cwd, ["update-ref", ref, oid]);
}

/** Deletes every ref under `prefix`, such as all of one conversation's checkpoints. Returns how many went. */
export async function unpinAll(cwd: string, prefix: string): Promise<number> {
  own(prefix);
  if (!prefix.endsWith("/")) throw new Error("A ref prefix ends with a slash.");
  const refs = (await git(cwd, ["for-each-ref", "--format=%(refname)", prefix])).stdout.split("\n").filter(Boolean);
  if (refs.length > 0) await git(cwd, ["update-ref", "--stdin"], { input: refs.map((ref) => `delete ${ref}\n`).join("") });
  return refs.length;
}
