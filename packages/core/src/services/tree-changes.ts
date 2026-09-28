import { git } from "@openorc/git";
import type { TurnFileChanges } from "@openorc/protocol";

const TREE_SHA = /^[a-f0-9]{40,64}$/;

/** Per-file counts and, on request, the patch between two immutable trees. Never reads the working directory. */
export async function treeChanges(rootPath: string, base: string, tree: string, options: { paths?: string[]; includePatch?: boolean } = {}): Promise<TurnFileChanges> {
  if (!TREE_SHA.test(base) || !TREE_SHA.test(tree)) throw new Error("The original comparison checkpoint is unavailable.");
  const args = ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", base, tree];
  const pathspec = options.paths?.length ? ["--", ...options.paths] : [];
  const exec = { maxBuffer: 8 * 1024 * 1024, timeoutMs: 15000 };
  const stat = await git(rootPath, [...args, "--numstat", "-z", ...pathspec], exec);
  const files = stat.stdout
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...path] = line.split("\t");
      return { path: path.join("\t"), added: added === "-" ? null : Number(added), removed: removed === "-" ? null : Number(removed) };
    });
  const patch = options.includePatch ? (await git(rootPath, [...args, "--patch", ...pathspec], exec)).stdout : null;
  return { files, patch };
}
