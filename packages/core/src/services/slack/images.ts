import { z } from "zod";
import type { WebClient } from "@slack/web-api";
import { settings, type Db } from "@openorc/db";
import { AttachmentService, MAX_IMAGE_BYTES } from "../attachments.js";

// Only public descriptors cross the relay; private URLs and Slack credentials stay on the host.
export const SlackFile = z.object({ id: z.string().min(1), name: z.string().optional(), mimetype: z.string().optional(), updated: z.number().optional() });
export type SlackFile = z.infer<typeof SlackFile>;
export const SlackImageData = z.union([z.object({ name: z.string(), mime: z.string(), dataBase64: z.string().max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4) }), z.object({ error: z.string().max(1000) })]);
export type SlackImageData = z.infer<typeof SlackImageData>;
export type LocalSlackImage = { path: string; name: string } | { error: string };

/** Download only authenticated Slack file URLs, with a hard streaming size bound. */
export async function downloadSlackImage(web: Pick<WebClient, "files">, token: string, id: string): Promise<SlackImageData> {
  try {
    const result = await web.files.info({ file: id });
    const file = result.file;
    if (!result.ok || !file || file.id !== id) return { error: "Slack could not provide this file. Check that the app can access it." };
    const mime = file.mimetype ?? "";
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)) return { error: "This attachment is not a supported image. Use PNG, JPEG, GIF, or WebP." };
    if ((file.size ?? 0) > MAX_IMAGE_BYTES) return { error: "This image exceeds the 20 MB limit." };
    let url = new URL(file.url_private_download ?? file.url_private ?? "");
    const signal = AbortSignal.timeout(20_000);
    for (let redirect = 0; redirect < 4; redirect++) {
      // Recheck every redirect before attaching the bearer token.
      if (url.protocol !== "https:" || url.hostname !== "files.slack.com" || url.port || url.username || url.password) return { error: "Slack returned an unsupported image download address." };
      const response = await fetch(url.href, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual", signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        url = new URL(response.headers.get("location") ?? "", url);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return { error: "Slack could not download this image. Check files:read and channel access." };
      }
      if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) {
        await response.body.cancel();
        return { error: "This image exceeds the 20 MB limit." };
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_IMAGE_BYTES) return { error: "This image exceeds the 20 MB limit." };
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      return { name: file.name ?? id, mime, dataBase64: Buffer.concat(chunks).toString("base64") };
    }
    return { error: "Slack redirected the image download too many times." };
  } catch (error) {
    const code = z.object({ data: z.object({ error: z.string() }) }).safeParse(error);
    return {
      error:
        code.success && code.data.data.error === "missing_scope"
          ? "Slack image access needs files:read. Add that bot scope and reinstall the Slack app in your workspace."
          : "Could not download this Slack image. Check file access and connection, then retry.",
    };
  }
}

/** Save validated local images once, so history and later turns reuse stable previews. */
export class SlackImages {
  constructor(
    private readonly db: Db,
    private readonly storage: AttachmentService,
  ) {}
  async load(workspace: string, file: SlackFile, download: (id: string) => Promise<unknown>): Promise<LocalSlackImage> {
    const key = `slack.image:${JSON.stringify([workspace, file.id, file.updated ?? null])}`;
    const cached = settings.get(this.db, key);
    if (cached) {
      try {
        const saved = z.object({ url: z.string(), name: z.string() }).parse(JSON.parse(cached));
        const [path] = await this.storage.forTask(`![image](${saved.url})`);
        if (path) return { path, name: saved.name };
      } catch {
        /* Missing local images are fetched again. */
      }
    }
    try {
      const data = SlackImageData.parse(await download(file.id));
      if ("error" in data) return data;
      const saved = await this.storage.save(data);
      settings.set(this.db, key, JSON.stringify({ url: saved.url, name: data.name }));
      return { path: saved.path, name: data.name };
    } catch {
      return { error: "This Slack image could not be saved or is not a valid supported image (maximum 20 MB and 40 megapixels)." };
    }
  }
}
