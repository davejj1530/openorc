import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { imageSize } from "image-size";
import { marked } from "marked";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** Base64 that decodes to bytes, checked before a buffer is allocated for it. */
function decode(dataBase64: string, limit: number, subject: string): Buffer {
  if (dataBase64.length > Math.ceil(limit / 3) * 4) throw new Error(`${subject}s must be 20 MB or smaller.`);
  if (dataBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(dataBase64) || !/^[^=]*={0,2}$/.test(dataBase64)) throw new Error(`The ${subject.toLowerCase()} data is invalid. Attach it again.`);
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.length === 0 || bytes.length > limit) throw new Error(`${subject}s must be between 1 byte and 20 MB.`);
  return bytes;
}

/**
 * One path segment built from the name the user gave the file, so an agent
 * reading the path can tell a spreadsheet from a log. Every separator and every
 * other character outside the safe set collapses to a dash, which is what makes
 * traversal inexpressible; the extension survives a long name being cut.
 */
export function storedFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  if (base.length === 0) return "attachment";
  if (base.length <= 80) return base;
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 && base.length - dot <= 12 ? base.slice(dot) : "";
  return base.slice(0, 80 - extension.length) + extension;
}

/** Images are stored separately from documents and retained for drafts, undo and run history. */
export class AttachmentService {
  private readonly directory: string;
  constructor(dataDir: string) {
    this.directory = path.join(dataDir, "attachments");
  }

  async save(input: { name: string; mime: string; dataBase64: string }): Promise<{ path: string; url: string }> {
    const extension = extensions[input.mime];
    if (!extension) throw new Error("Use a PNG, JPEG, GIF, or WebP image.");
    const bytes = decode(input.dataBase64, MAX_IMAGE_BYTES, "Image");
    let size;
    try {
      size = imageSize(bytes);
    } catch {
      throw new Error("This file is not a readable image.");
    }
    if (size.type !== extension) throw new Error("The image format does not match its file type.");
    if (size.width * size.height > 40_000_000 || size.width > 16384 || size.height > 16384)
      throw new Error("Image dimensions are too large. Use an image below 40 megapixels and 16,384 pixels per side.");
    await mkdir(this.directory, { recursive: true });
    const name = `${randomUUID()}.${extension}`;
    const target = path.join(this.directory, name);
    await writeFile(target, bytes, { flag: "wx" });
    return { path: target, url: `openorc-asset://attachments/${name}` };
  }

  /**
   * Any other file the user attached. It lands beside the images but gets no
   * asset URL: the protocol handler serves images alone, and nothing about a
   * spreadsheet or a log belongs on a fetchable endpoint. The agent is handed
   * the path and opens it with its own file tools.
   */
  async saveFile(input: { name: string; dataBase64: string }): Promise<{ path: string; name: string; bytes: number }> {
    const name = input.name.trim();
    if (!name) throw new Error("This file has no name. Rename it and attach it again.");
    const bytes = decode(input.dataBase64, MAX_FILE_BYTES, "File");
    await mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, `${randomUUID()}-${storedFileName(name)}`);
    await writeFile(target, bytes, { flag: "wx" });
    return { path: target, name, bytes: bytes.length };
  }

  async forTask(markdown: string): Promise<string[]> {
    const urls: string[] = [];
    marked.walkTokens(marked.lexer(markdown), (token) => {
      if (token.type === "image") {
        if (token.href.startsWith("openorc-pending:")) throw new Error("A task image has not finished saving. Open the task and retry or remove it before starting.");
        if (token.href.startsWith("openorc-asset:")) urls.push(token.href);
      }
    });
    return Promise.all(
      [...new Set(urls)].map(async (src) => {
        const match = /^openorc-asset:\/\/attachments\/([a-f0-9-]+\.(?:png|jpg|gif|webp))$/.exec(src);
        if (!match) throw new Error("This task contains an invalid image reference. Replace or remove it before starting.");
        const target = path.join(this.directory, match[1]!);
        try {
          const [directory, resolved] = await Promise.all([realpath(this.directory), realpath(target)]);
          if (path.dirname(resolved) !== directory) throw new Error("Image outside attachments");
          // Revalidate persisted assets as files can be removed or changed outside the app.
          const metadata = await stat(resolved);
          if (!metadata.isFile() || metadata.size > MAX_IMAGE_BYTES) throw new Error("Image too large or not a file");
          const bytes = await readFile(resolved);
          if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Image too large");
          imageSize(bytes);
          return resolved;
        } catch {
          throw new Error("A task image is missing or unreadable. Open the task and replace or remove it before starting.");
        }
      }),
    );
  }
}
