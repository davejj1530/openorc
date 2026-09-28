import { TOOL_IMAGE_URL } from "@openorc/protocol";

/** Local transcript links must never be resolved against the renderer's URL. */
export function localPath(value: string, basePath?: string): string | null {
  if (!value || value.includes("\0") || value.startsWith("//")) return null;
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== "localhost") return null;
      const path = decodeURIComponent(url.pathname);
      if (path.includes("\0") || path.startsWith("//")) return null;
      return /^\/[a-z]:\//i.test(path) ? path.slice(1) : path;
    } catch {
      return null;
    }
  }
  if (/^[a-z]:[\\/]/i.test(value)) return value;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("#")) return null;
  let path: string;
  try {
    path = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (path.includes("\0") || path.startsWith("//")) return null;
  if (path.startsWith("/") || /^[a-z]:[\\/]/i.test(path)) return path;
  return basePath ? `${basePath.replace(/[\\/]$/, "")}/${path}` : null;
}

export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(path);
}

export function imageSource(value: string, basePath?: string): string | null {
  if (/^openorc-asset:\/\/attachments\/[a-f\d-]+\.(png|jpg|gif|webp)$/i.test(value)) return value;
  if (TOOL_IMAGE_URL.test(value)) return value;
  if (/^data:image\/(png|jpeg|gif|webp|avif);base64,[a-z\d+/=\s]+$/i.test(value)) return value;
  const path = localPath(value, basePath);
  return path && isImagePath(path) ? `openorc-asset://local-image/?path=${encodeURIComponent(path)}` : null;
}
