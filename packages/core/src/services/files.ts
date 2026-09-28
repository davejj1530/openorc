import { git } from "@openorc/git";
import type { Project } from "@openorc/protocol";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

interface Listing {
  at: number;
  files: string[];
}

/** Ranks a path for a query: a basename that starts with it beats one that contains it beats a directory match. */
export function rankPath(file: string, query: string): number {
  const q = query.toLowerCase();
  const lower = file.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (base === q) return 0;
  if (base.startsWith(q)) return 1;
  if (base.includes(q)) return 2;
  if (lower.includes(q)) return 3;
  // Every character in order, the way editors' quick-open matches.
  let i = 0;
  for (const c of lower) if (c === q[i]) i += 1;
  return i === q.length ? 4 : -1;
}

/** Tracked files of a project for @ mentions, listed once and kept for half a minute. */
export class FileService {
  private readonly cache = new Map<string, Listing>();

  /** Bounded, read-only source preview. Resolve symlinks before checking the workspace boundary. */
  async read(rootPath: string, path: string): Promise<{ path: string; content: string }> {
    if (path.includes("\0")) throw new Error("Invalid file path.");
    const root = await realpath(rootPath);
    const target = await realpath(resolve(rootPath, path)).catch(() => {
      throw new Error("File not found. It may have moved or been deleted.");
    });
    const local = relative(root, target);
    if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error("This file is outside the conversation's workspace.");
    const file = await open(target, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("This path is a folder, not a file.");
      const limit = 2 * 1024 * 1024;
      if (stat.size > limit) throw new Error("This file is too large to preview (2 MB maximum).");
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > limit) throw new Error("This file is too large to preview (2 MB maximum).");
      const bytes = buffer.subarray(0, length);
      if (bytes.includes(0)) throw new Error("This is a binary file and cannot be shown as code.");
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("This file is not UTF-8 text and cannot be previewed.");
      }
      return { path: target, content };
    } finally {
      await file.close();
    }
  }

  async search(project: Project, query: string, limit = 20): Promise<string[]> {
    const files = await this.list(project);
    const q = query.trim();
    if (!q) return files.slice(0, limit);
    return files
      .map((f) => ({ f, rank: rankPath(f, q) }))
      .filter((x) => x.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.f.length - b.f.length)
      .slice(0, limit)
      .map((x) => x.f);
  }

  private async list(project: Project): Promise<string[]> {
    const hit = this.cache.get(project.id);
    if (hit && Date.now() - hit.at < 30_000) return hit.files;
    const out = (await git(project.rootPath, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 256 * 1024 * 1024 })).stdout;
    const files = out.split("\0").filter(Boolean);
    this.cache.set(project.id, { at: Date.now(), files });
    return files;
  }
}
