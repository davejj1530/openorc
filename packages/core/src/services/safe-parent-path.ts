import { lstat } from "node:fs/promises";
import path from "node:path";

/**
 * Validate a workspace-relative file path and each existing parent directory.
 * Missing parents are allowed for later creation. The map records device/inode
 * identities across checks, so callers must retain it and check again after
 * awaited preparation and immediately before publishing or copying a file.
 */
export async function assertSafeParentPath(root: string, file: string, directories: Map<string, string>): Promise<void> {
  const parts = file.split("/");
  if (path.isAbsolute(file) || parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error(`Unsafe path ${file}.`);
  let directory = root;
  for (const part of ["", ...parts.slice(0, -1)]) {
    if (part) directory = path.join(directory, part);
    const stat = await lstat(directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe parent directory for ${file}; file/directory transitions require manual integration.`);
    const identity = `${stat.dev}:${stat.ino}`;
    const previous = directories.get(directory);
    if (previous && previous !== identity) throw new Error(`Parent directory changed while publishing ${file}.`);
    directories.set(directory, identity);
  }
}
