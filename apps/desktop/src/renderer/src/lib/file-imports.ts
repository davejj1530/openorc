import { core } from "./rpc";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export type ImportedFile = { path: string; name: string; bytes: number };

/** Reads a blob as the base64 body the core stores, without the data URL prefix. */
export function readAsBase64(file: Blob, subject = "file"): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
    reader.onerror = () => reject(new Error(`Couldn’t read this ${subject}. Try again.`));
    reader.readAsDataURL(file);
  });
}

export function validateFile(file: Blob, name: string): void {
  if (!name.trim()) throw new Error("This file has no name. Rename it and attach it again.");
  if (file.size === 0 || file.size > MAX_FILE_BYTES) throw new Error("Files must be between 1 byte and 20 MB.");
}

/**
 * Copies any non-image attachment into the app's own storage and returns where
 * it landed. The agent is handed that path; unlike an image it never gets an
 * asset URL, because only images are served back over the asset protocol.
 */
export async function importFile(file: Blob, name: string): Promise<ImportedFile> {
  validateFile(file, name);
  return core.call("attachments.saveFile", { name, dataBase64: await readAsBase64(file) });
}

/** The formats the app previews and the providers take as picture input. */
export function isImageAttachment(file: Pick<File, "type" | "name">): boolean {
  return /^image\/(png|jpeg|gif|webp)$/.test(file.type) || /\.(png|jpe?g|gif|webp)$/i.test(file.name);
}

const UNITS = ["B", "KB", "MB"];
/** A size a person can read at a glance; the composer chip has room for three characters and a unit. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}
