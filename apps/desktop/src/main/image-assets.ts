import { isAbsolute } from "node:path";
import { profileAssetPath, readImageFile, type ImageFileRead } from "@openorc/core/profile-assets";

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

const failures: Record<Exclude<ImageFileRead, { ok: true }>["reason"], () => Response> = {
  unsupported: () => new Response(null, { status: 415 }),
  missing: () => new Response(null, { status: 404 }),
  "too-large": () => new Response("Image exceeds 32 MB", { status: 413 }),
};

/** Image-only file access; never expose a general-purpose file fetch endpoint. */
export async function imageAssetResponse(request: Request, dataDir: string): Promise<Response> {
  try {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const url = new URL(request.url);
    let path: string | null;
    // Any image on disk, for the app's own windows only. Phone access never reaches this branch.
    if (url.hostname === "local-image") {
      path = url.searchParams.get("path") ?? "";
      if (!isAbsolute(path) || path.includes("\0")) return new Response(null, { status: 400 });
    } else path = profileAssetPath(url.href, dataDir);
    if (!path) return new Response(null, { status: 404 });
    const read = await readImageFile(path, mimeTypes);
    if (!read.ok) return failures[read.reason]();
    return new Response(read.bytes, {
      headers: {
        "Content-Type": read.mime,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
