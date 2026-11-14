import sharp from "sharp";

type LogoResult = { logo: string | null } | { error: string };

/** The wire takes a raster already cropped to the desktop's 128-pixel square. */
export async function checkedLogo(value: unknown): Promise<LogoResult> {
  if (value === null) return { logo: null };
  if (typeof value !== "string" || !/^data:image\/(png|jpeg|webp);base64,/.test(value)) return { error: "Pick a PNG, JPEG or WebP picture." };
  if (value.length > 64_000) return { error: "That picture is too big. Pick a smaller one." };
  const bytes = Buffer.from(value.slice(value.indexOf(",") + 1), "base64");
  const signature = matchesSignature(value, bytes);
  if (!signature) return { error: "That file isn't the picture it says it is. Pick a PNG, JPEG or WebP." };
  try {
    const raster = sharp(bytes, { limitInputPixels: 128 * 128, failOn: "warning", animated: true });
    const metadata = await raster.metadata();
    if (metadata.width !== 128 || metadata.height !== 128 || (metadata.pages ?? 1) !== 1) throw new Error("Invalid dimensions");
    const logo = `data:image/webp;base64,${(await raster.webp({ lossless: true }).toBuffer()).toString("base64")}`;
    return logo.length > 64_000 ? { error: "That picture is too big. Pick a smaller one." } : { logo };
  } catch {
    return { error: "That picture couldn't be read. Pick another PNG, JPEG or WebP." };
  }
}

function matchesSignature(value: string, bytes: Buffer): boolean {
  if (value.startsWith("data:image/png")) return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (value.startsWith("data:image/jpeg")) return bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  return bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
}
