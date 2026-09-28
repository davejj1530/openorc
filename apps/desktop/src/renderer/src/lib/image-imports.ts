import { core } from "./rpc";
import { readAsBase64 } from "./file-imports";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const IMAGE_ACCEPT = IMAGE_TYPES.join(",");
export type ImportedImage = { path: string; url: string };
type StagedImage = { id: string; file: Blob; name: string; saved?: ImportedImage };
const inFlight = new Map<string, Promise<ImportedImage>>();

export function validateImage(file: Blob): void {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error("Use a PNG, JPEG, GIF, or WebP image.");
  if (file.size === 0 || file.size > 20 * 1024 * 1024) throw new Error("Images must be between 1 byte and 20 MB.");
}

export async function importImage(file: Blob, name: string): Promise<ImportedImage> {
  validateImage(file);
  return core.call("attachments.save", { name, mime: file.type, dataBase64: await readAsBase64(file, "image") });
}

let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("openorc-image-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("images", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(new Error("Couldn’t keep the image draft on this device. Try again."));
    };
  }));
}

async function put(value: StagedImage): Promise<void> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction("images", "readwrite");
    tx.objectStore("images").put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(new Error("Couldn’t keep the image draft on this device. Free some storage and retry."));
  });
}

export async function readStagedImage(id: string): Promise<StagedImage> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction("images").objectStore("images").get(id);
    request.onsuccess = () => (request.result ? resolve(request.result) : reject(new Error("This image draft is unavailable. Remove it and paste the image again.")));
    request.onerror = () => reject(new Error("Couldn’t read the image draft. Retry or paste it again."));
  });
}

/** Stage bytes before inserting their ID into a locally persisted document. */
export async function stageImage(file: File): Promise<string> {
  validateImage(file);
  const id = crypto.randomUUID();
  await put({ id, file, name: file.name || "Pasted image" });
  return id;
}

/** Shared across mounts: navigating away cannot cancel or duplicate the import. */
export function finishImageImport(id: string): Promise<ImportedImage> {
  const existing = inFlight.get(id);
  if (existing) return existing;
  const pending = readStagedImage(id)
    .then(async (record) => {
      if (record.saved) return record.saved;
      const saved = await importImage(record.file, record.name);
      await put({ ...record, saved });
      return saved;
    })
    .finally(() => inFlight.delete(id));
  inFlight.set(id, pending);
  return pending;
}
