import type { UploadedFile } from "../wire-files.js";

const mp4Brands = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "M4V "]);

/** Signature-based media classification keeps an executable with a picture name a download. */
export function fileKind(bytes: Buffer): Pick<UploadedFile, "contentType" | "kind"> {
  const head = bytes.subarray(0, 64);
  const at = (offset: number, text: string) => head.toString("latin1", offset, offset + text.length) === text;
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { contentType: "image/png", kind: "image" };
  if (head.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return { contentType: "image/jpeg", kind: "image" };
  if (at(0, "GIF8")) return { contentType: "image/gif", kind: "image" };
  if (at(0, "RIFF") && at(8, "WEBP")) return { contentType: "image/webp", kind: "image" };
  return audioVideoKind(head);
}

function audioVideoKind(head: Buffer): Pick<UploadedFile, "contentType" | "kind"> {
  const text = head.toString("latin1");
  const brand = text.slice(8, 12);
  if (text.slice(4, 8) === "ftyp") {
    if (mp4Brands.has(brand)) return { contentType: "video/mp4", kind: "video" };
    if (brand === "qt  ") return { contentType: "video/quicktime", kind: "video" };
    if (["M4A ", "M4B "].includes(brand)) return { contentType: "audio/mp4", kind: "audio" };
  }
  if (head.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) && text.includes("webm")) return { contentType: "video/webm", kind: "video" };
  if (text.startsWith("ID3") || (head[0] === 255 && [251, 250, 243, 242].includes(head[1]!))) return { contentType: "audio/mpeg", kind: "audio" };
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WAVE") return { contentType: "audio/wav", kind: "audio" };
  if (text.startsWith("OggS")) return { contentType: "audio/ogg", kind: "audio" };
  if (text.startsWith("fLaC")) return { contentType: "audio/flac", kind: "audio" };
  return { contentType: "application/octet-stream", kind: "file" };
}
