import { HostedDraftFile, hostedFilesRpcParams, type HostedFileDraft, type HostedFileRef } from "@openorc/protocol";

type Transfer = { kind: "pending" | "stored" | "removing" | "accepted" } | { kind: "failed"; message: string };
export interface HostedAttachmentSource {
  draft: HostedFileDraft;
  file: HostedDraftFile;
  blob: Blob | null;
  transfer: Transfer;
}

/** Account, origin and destination are part of the draft identity, even when two people open the same thread. */
export function hostedAttachmentKey({ scope, draftKey }: HostedFileDraft): string {
  const place = scope.destination;
  const destination = place.kind === "hosted" ? [place.kind, place.projectId, place.threadId ?? null] : [place.kind, place.conversationId];
  return JSON.stringify([scope.apiOrigin, scope.accountId, scope.spaceId, ...destination, draftKey]);
}

const STORE = "sources";
const UNAVAILABLE = "This file couldn't be kept on this device. Free some storage and retry.";

/** Blobs are kept before a chip appears, then released only after the core has durably stored every byte. */
export class HostedAttachmentStore {
  #database: Promise<IDBDatabase> | null = null;
  constructor(private readonly name = "openorc-hosted-attachments") {}

  async put(source: HostedAttachmentSource): Promise<void> {
    await this.#request("readwrite", (store) => store.put(source, key({ ...source.draft, id: source.file.id })));
  }

  async list(draft: HostedFileDraft): Promise<HostedAttachmentSource[]> {
    const namespace = hostedAttachmentKey(draft);
    const values: unknown[] = await this.#request("readonly", (store) => store.getAll(IDBKeyRange.bound([namespace, ""], [namespace, "\uffff"])));
    return values.map(readSource).sort((a, b) => a.file.selectedAt - b.file.selectedAt);
  }

  async get(ref: HostedFileRef): Promise<HostedAttachmentSource | null> {
    const value: unknown = await this.#request("readonly", (store) => store.get(key(ref)));
    return value === undefined ? null : readSource(value);
  }

  async remove(ref: HostedFileRef): Promise<void> {
    await this.#request("readwrite", (store) => store.delete(key(ref)));
  }

  /** A transfer finishing after Remove cannot recreate its source record. */
  async change(ref: HostedFileRef, update: (source: HostedAttachmentSource) => HostedAttachmentSource): Promise<void> {
    const database = await this.#open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const request = store.get(key(ref));
      request.onsuccess = () => {
        if (request.result === undefined) return;
        try {
          store.put(update(readSource(request.result)), key(ref));
        } catch {
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(new Error(UNAVAILABLE));
    });
  }

  async close(): Promise<void> {
    (await this.#database)?.close();
    this.#database = null;
  }

  #open(): Promise<IDBDatabase> {
    return (this.#database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        this.#database = null;
        reject(new Error(UNAVAILABLE));
      };
    }));
  }

  async #request<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await this.#open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(new Error(UNAVAILABLE));
    });
  }
}

function key(ref: HostedFileRef): [string, string] {
  return [hostedAttachmentKey(ref), ref.id];
}

function readSource(value: unknown): HostedAttachmentSource {
  if (!value || typeof value !== "object" || !("draft" in value) || !("file" in value) || !("blob" in value) || !("transfer" in value)) throw new Error(UNAVAILABLE);
  const draft = hostedFilesRpcParams["hostedFiles.state"].parse(value.draft);
  const file = HostedDraftFile.parse(value.file);
  if (value.blob !== null && !(value.blob instanceof Blob)) throw new Error(UNAVAILABLE);
  return { draft, file, blob: value.blob, transfer: readTransfer(value.transfer) };
}

function readTransfer(transfer: unknown): Transfer {
  if (!transfer || typeof transfer !== "object" || !("kind" in transfer)) throw new Error(UNAVAILABLE);
  if (transfer.kind === "pending" || transfer.kind === "stored" || transfer.kind === "removing" || transfer.kind === "accepted") return { kind: transfer.kind };
  if (transfer.kind === "failed" && "message" in transfer && typeof transfer.message === "string") return { kind: "failed", message: transfer.message };
  throw new Error(UNAVAILABLE);
}
