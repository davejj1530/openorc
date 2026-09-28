import { open } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { TOOL_IMAGE_URL } from "@openorc/protocol";

const mimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

/** Image-only file access; never expose a general-purpose file fetch endpoint. */
export async function imageAssetResponse(request: Request, dataDir: string): Promise<Response> {
  try {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const url = new URL(request.url);
    let path: string;
    if (url.hostname === "attachments") {
      const name = decodeURIComponent(url.pathname.slice(1));
      if (!/^[a-f0-9-]+\.(png|jpg|gif|webp)$/.test(name)) return new Response(null, { status: 404 });
      path = join(dataDir, "attachments", name);
    } else if (url.hostname === "tool-images") {
      const match = TOOL_IMAGE_URL.exec(url.href);
      if (!match) return new Response(null, { status: 404 });
      path = join(dataDir, "tool-images", match[1]!, match[2]!);
    } else if (url.hostname === "local-image") {
      path = url.searchParams.get("path") ?? "";
      if (!isAbsolute(path) || path.includes("\0")) return new Response(null, { status: 400 });
    } else return new Response(null, { status: 404 });
    const mime = mimeTypes[extname(path).toLowerCase()];
    if (!mime) return new Response(null, { status: 415 });
    const file = await open(path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return new Response(null, { status: 404 });
      if (stat.size > 32 * 1024 * 1024) return new Response("Image exceeds 32 MB", { status: 413 });
      return new Response(new Uint8Array(await file.readFile()), {
        headers: {
          "Content-Type": mime,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    } finally {
      await file.close();
    }
  } catch {
    return new Response(null, { status: 404 });
  }
}
