import { nativeImage } from "electron";
import { imageSize } from "image-size";
import { extname } from "node:path";
import { readSmallFile, ICON_EXTENSION } from "./project-icon-discovery";
import { icoPng } from "./project-icon-ico";

export interface IconPreview {
  dataUrl: string;
  square: boolean;
}

function vectorPreview(bytes: Buffer): string {
  const svg = bytes.toString("utf8");
  // Render only as an image, never inline markup. Keep vectors small and static,
  // with no linked resources, fonts, filters or animation to load or run later.
  const externalPaint = [...svg.matchAll(/url\(([^)]*)\)/gi)].some((match) => !/^["']?#/.test(match[1]!.trim()));
  if (
    bytes.length > 16 * 1024 ||
    externalPaint ||
    /<!|<\s*(?:script|foreignObject|image|use|animate\w*|set|filter|fe\w+)\b|\bon\w+\s*=|(?:href|src)\s*=|@import|@font-face|@keyframes|\banimation(?:-\w+)?\s*:/i.test(svg)
  ) {
    throw new Error("Choose a small, self-contained SVG or a PNG image.");
  }
  return `data:image/svg+xml;base64,${bytes.toString("base64")}`;
}

/** Decode once, after checking compressed bytes and pixel count; no new native image library. */
export async function createIconPreview(file: string): Promise<IconPreview> {
  if (!ICON_EXTENSION.test(file)) throw new Error("Choose a PNG, JPEG, WebP, ICO or SVG image.");
  const source = await readSmallFile(file, 2 * 1024 * 1024);
  const bytes = extname(file).toLowerCase() === ".ico" ? icoPng(source) : source;
  const { width, height } = imageSize(bytes);
  if (!width || !height || width * height > 4 * 1024 * 1024 || Math.max(width, height) > 4096) throw new Error("Choose an image no larger than 4 megapixels.");
  let dataUrl: string;
  if (extname(file).toLowerCase() === ".svg") dataUrl = vectorPreview(bytes);
  else {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error("This image could not be read. Try a PNG image.");
    const size = image.getSize();
    const scale = Math.min(1, 64 / Math.max(size.width, size.height));
    dataUrl = image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: "good" }).toDataURL();
  }
  if (dataUrl.length > 24 * 1024) throw new Error("This icon is too complex. Choose a simpler image.");
  return { dataUrl, square: width / height >= 0.8 && width / height <= 1.25 };
}
