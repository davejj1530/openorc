import { mkdir, readdir, realpath, rename, rmdir } from "node:fs/promises";
import path from "node:path";
import { orclingHandle } from "@openorc/protocol";

/**
 * An Orcling's desk: a folder named after it inside the app's Orclings folder, so Rini works in
 * `orclings/rini`. Renaming the Orcling moves its desk. A folder the person chose for its
 * conversation elsewhere is theirs, and is never moved or removed.
 */
export class OrclingFolders {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "orclings");
  }

  /** Makes a new Orcling's folder. One left behind by a deleted Orcling of the same name is reused. */
  async create(name: string): Promise<string> {
    const folder = path.join(this.root, orclingHandle(name));
    await mkdir(folder, { recursive: true });
    return realpath(folder);
  }

  /** Where the folder moves for this name, or null when it stays: it already matches, or the app did not make it. */
  async destination(current: string | null | undefined, name: string): Promise<string | null> {
    const own = await this.own(current);
    if (!own) return null;
    const next = path.join(path.dirname(own), orclingHandle(name));
    return next === own ? null : next;
  }

  /** Moves an Orcling's folder to its new name and returns where it now is. Files already at the destination are never replaced. */
  async move(from: string, to: string): Promise<string> {
    if ((await readdir(to).catch(() => [])).length > 0) throw new Error(`There is already a folder at ${to}. Move or delete it, then try again.`);
    await rename(from, to).catch(async (error: NodeJS.ErrnoException) => {
      // A folder removed by hand is simply made again.
      if (error.code !== "ENOENT") throw error;
      await mkdir(to, { recursive: true });
    });
    return realpath(to);
  }

  /** Files an Orcling made stay after it is deleted; only its empty folder goes. */
  async removeIfEmpty(folder: string | null | undefined): Promise<void> {
    const own = await this.own(folder);
    if (own && (await readdir(own).catch(() => ["unreadable"])).length === 0) await rmdir(own).catch(() => undefined);
  }

  /** The folder as a path inside the app's Orclings folder, or null when it lives anywhere else. */
  private async own(folder: string | null | undefined): Promise<string | null> {
    if (!folder) return null;
    const [parent, root] = await Promise.all([realpath(path.dirname(folder)).catch(() => null), realpath(this.root).catch(() => null)]);
    return parent && parent === root ? path.join(root, path.basename(folder)) : null;
  }
}
