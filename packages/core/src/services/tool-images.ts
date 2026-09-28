import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { TOOL_IMAGE_URL, inlineToolImages, type ToolImage } from "@openorc/protocol";

const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const mimes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const RUN_FOLDER = /^[A-Za-z0-9-]+$/;

/**
 * Screenshots and other images tools return, one folder per run under the profile, so the ledger holds a URL
 * instead of megabytes of base64. The desktop app serves them through its image-only asset protocol. A run's
 * folder goes when the run does.
 */
export class ToolImageStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "tool-images");
  }

  /** Writes one image and returns its URL, or null to keep it inline when it cannot be written. */
  save(runId: string, image: ToolImage): string | null {
    const extension = extensions[image.mime];
    if (!extension || !RUN_FOLDER.test(runId)) return null;
    try {
      const folder = path.join(this.dir, runId);
      mkdirSync(folder, { recursive: true });
      const name = `${randomUUID()}.${extension}`;
      writeFileSync(path.join(folder, name), Buffer.from(image.data, "base64"), { flag: "wx" });
      return `openorc-asset://tool-images/${runId}/${name}`;
    } catch {
      return null;
    }
  }

  load(url: string): ToolImage | null {
    const match = TOOL_IMAGE_URL.exec(url);
    if (!match) return null;
    const [, runId, name] = match as unknown as [string, string, string];
    try {
      return { mime: mimes[name.split(".").pop()!]!, data: readFileSync(path.join(this.dir, runId, name)).toString("base64") };
    } catch {
      return null;
    }
  }

  /** A tool output as the tool returned it, for a reader that needs the bytes. */
  inline(output: unknown): unknown {
    return inlineToolImages(output, (url) => this.load(url));
  }

  /** Removes the folders of runs that no longer exist and returns how many went. Never throws: a folder it cannot remove is tried again next time. */
  async prune(exists: (runId: string) => boolean): Promise<number> {
    const folders = await readdir(this.dir).catch(() => [] as string[]);
    const gone = folders.filter((runId) => RUN_FOLDER.test(runId) && !exists(runId));
    const removed = await Promise.allSettled(gone.map((runId) => rm(path.join(this.dir, runId), { recursive: true, force: true })));
    return removed.filter((result) => result.status === "fulfilled").length;
  }
}
