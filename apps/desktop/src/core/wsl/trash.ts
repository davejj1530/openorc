import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The Trash inside a WSL distribution. The Windows Recycle Bin takes nothing from a distribution's disk, so what the
 * user removes goes where a Linux desktop would put it, by the freedesktop.org Trash specification: the home Trash for
 * anything on the home's disk, and `.Trash-<uid>` at the top of any other. Nothing is deleted instead.
 */

const two = (value: number) => String(value).padStart(2, "0");

/** Local time without a zone, as the specification asks. */
function deletionDate(at: Date): string {
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}`;
}

/** The highest folder on the same disk as `file`: where a Trash for that disk goes. */
async function topOf(file: string, device: number): Promise<string> {
  let dir = path.dirname(file);
  for (;;) {
    const parent = path.dirname(dir);
    if (parent === dir || (await stat(parent)).dev !== device) return dir;
    dir = parent;
  }
}

async function trashFor(file: string, home: string, uid: number): Promise<string> {
  const homeTrash = path.join(process.env["XDG_DATA_HOME"] || path.join(home, ".local", "share"), "Trash");
  const device = (await stat(file)).dev;
  await mkdir(homeTrash, { recursive: true, mode: 0o700 });
  if ((await stat(homeTrash)).dev === device) return homeTrash;
  return path.join(await topOf(file, device), `.Trash-${uid}`);
}

/**
 * Claims a name in the Trash by creating its record, which the specification makes the lock: two removals of files
 * with one name each get their own.
 */
async function claim(trash: string, name: string, original: string, at: Date): Promise<string> {
  const record = `[Trash Info]\nPath=${original.split("/").map(encodeURIComponent).join("/")}\nDeletionDate=${deletionDate(at)}\n`;
  for (let attempt = 1; ; attempt++) {
    const candidate = attempt === 1 ? name : `${name}.${attempt}`;
    try {
      const handle = await open(path.join(trash, "info", `${candidate}.trashinfo`), "wx", 0o600);
      try {
        await handle.writeFile(record);
      } finally {
        await handle.close();
      }
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 10_000) throw error;
    }
  }
}

/** Moves a file or folder to the Trash of the disk it is on. */
export async function moveToTrash(file: string, options: { home?: string; uid?: number; now?: () => Date } = {}): Promise<void> {
  if (!path.isAbsolute(file)) throw new Error("Only a full path can be moved to the Trash.");
  const trash = await trashFor(file, options.home ?? os.homedir(), options.uid ?? os.userInfo().uid);
  await mkdir(path.join(trash, "files"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(trash, "info"), { recursive: true, mode: 0o700 });
  const name = await claim(trash, path.basename(file), file, (options.now ?? (() => new Date()))());
  try {
    await rename(file, path.join(trash, "files", name));
  } catch (error) {
    await rm(path.join(trash, "info", `${name}.trashinfo`), { force: true });
    throw error;
  }
}
