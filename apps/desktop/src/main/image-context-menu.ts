import { writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { dialog, Menu, type BrowserWindow } from "electron";
import { TOOL_IMAGE_URL } from "@openorc/protocol";
import { imageAssetResponse } from "./image-assets";
import { isImagePath } from "../shared/image-paths";
import { linkMenuItems } from "./link-navigation";

const maxImageBytes = 32 * 1024 * 1024;

function imageFilename(source: string): string | null {
  const inline = /^data:image\/(png|jpeg|gif|webp|avif);base64,/i.exec(source);
  if (inline) return `image.${inline[1]!.toLowerCase().replace("jpeg", "jpg")}`;
  try {
    const url = new URL(source);
    if (url.protocol !== "openorc-asset:" || url.username || url.password || url.port) return null;
    if (url.hostname === "attachments") {
      const name = decodeURIComponent(url.pathname.slice(1));
      return /^[a-f\d-]+\.(png|jpg|gif|webp)$/.test(name) ? name : null;
    }
    if (url.hostname === "tool-images") return TOOL_IMAGE_URL.exec(url.href)?.[2] ?? null;
    if (url.hostname === "local-image") {
      const path = url.searchParams.get("path") ?? "";
      return isAbsolute(path) && !path.includes("\0") && isImagePath(path) ? basename(path) : null;
    }
  } catch {
    // Only the app's image-only protocol and inline raster images are downloadable.
  }
  return null;
}

async function imageBytes(source: string, dataDir: string): Promise<Uint8Array> {
  if (source.startsWith("data:")) {
    const data = source.slice(source.indexOf(",") + 1);
    if (data.length > Math.ceil(maxImageBytes / 3) * 4) throw new Error("Image exceeds 32 MB.");
    if (!data || !/^[a-z\d+/=\s]+$/i.test(data)) throw new Error("The image data is unavailable.");
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > maxImageBytes) throw new Error("The image data is unavailable or exceeds 32 MB.");
    return bytes;
  }
  const response = await imageAssetResponse(new Request(source), dataDir);
  if (!response.ok) throw new Error(response.status === 413 ? "Image exceeds 32 MB." : "The image may have moved or been deleted.");
  return new Uint8Array(await response.arrayBuffer());
}

async function downloadImage(window: BrowserWindow, source: string, filename: string, dataDir: string): Promise<void> {
  try {
    const result = await dialog.showSaveDialog(window, {
      title: "Download image",
      defaultPath: filename,
      filters: [{ name: "Image", extensions: [extname(filename).slice(1)] }],
    });
    if (result.canceled || !result.filePath) return;
    // Retain the original encoding (including animation/vector data), not a screenshot.
    const bytes = await imageBytes(source, dataDir);
    await writeFile(result.filePath, bytes);
  } catch (error) {
    if (!window.isDestroyed()) {
      await dialog.showMessageBox(window, {
        type: "error",
        message: "Could not download image",
        detail: error instanceof Error ? error.message : "Please try again.",
      });
    }
  }
}

/** Chromium supplies link destinations and image hit-test coordinates for the native menu. */
export function installImageContextMenu(window: BrowserWindow, dataDir: string): void {
  const contents = window.webContents;
  contents.on("context-menu", (_event, params) => {
    const links = linkMenuItems(window, params.linkURL);
    const filename = params.mediaType === "image" && params.hasImageContents ? imageFilename(params.srcURL) : null;
    if (!filename) {
      if (links.length) Menu.buildFromTemplate(links).popup({ window });
      return;
    }
    Menu.buildFromTemplate([
      ...links,
      ...(links.length ? [{ type: "separator" as const }] : []),
      {
        label: "Copy image",
        click: () => {
          if (!contents.isDestroyed()) contents.copyImageAt(params.x, params.y);
        },
      },
      {
        label: "Download image…",
        click: () => {
          if (!window.isDestroyed()) void downloadImage(window, params.srcURL, filename, dataDir);
        },
      },
    ]).popup({ window });
  });
}
