import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { FileByteSource } from "@openorc/hosted";
import { FILE_NOT_IN_DRAFT, HOSTED_FILE_CHUNK_BYTES, HostedFileRecord, newHostedFile, sameFileDraft, type HostedFileRef, type NewHostedFile } from "./hosted-file-record.js";

/** Durable bytes and upload receipts outlive windows and process restarts; account namespaces never share them. */
export class HostedFileStore {
  readonly #pending = new Map<string, Promise<unknown>>();
  #selectedAt = 0;
  constructor(private readonly dataDir: string) {}

  begin(input: NewHostedFile): Promise<HostedFileRecord> {
    const fresh = newHostedFile(input);
    fresh.selectedAt = this.#selectedAt = Math.max(Date.now(), this.#selectedAt + 1);
    return this.#serial(fresh, async () => {
      const prior = await this.#load(fresh);
      if (prior) {
        if (prior.name !== input.name || prior.bytes !== input.bytes || prior.mime !== input.mime) throw new Error(FILE_NOT_IN_DRAFT);
        return prior;
      }
      await this.#save(fresh);
      return fresh;
    });
  }

  async list(input: Pick<HostedFileRef, "scope" | "draftKey">): Promise<HostedFileRecord[]> {
    const records = await this.#records(input.scope);
    return records.filter((record) => sameFileDraft(record, input)).sort((a, b) => a.selectedAt - b.selectedAt);
  }

  /** Forgets every file of an organization's drafts, bytes and all, once the account no longer belongs to it. */
  async forgetSpace(left: { apiOrigin: string; accountId: string; spaceId: string }): Promise<void> {
    for (const record of await this.#records(left)) if (record.scope.spaceId === left.spaceId) await this.remove(record);
  }

  async #records(scope: Pick<HostedFileRef["scope"], "apiOrigin" | "accountId">): Promise<HostedFileRecord[]> {
    const directory = this.#directory(scope);
    const entries = await readdir(directory).catch((error: unknown) => {
      if (missing(error)) return [];
      throw error;
    });
    const result: HostedFileRecord[] = [];
    for (const name of entries) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
      const record = await this.#read(path.join(directory, name));
      if (record) result.push(record);
    }
    return result;
  }

  async get(ref: HostedFileRef): Promise<HostedFileRecord> {
    const record = await this.#load(ref);
    if (!record) throw new Error(FILE_NOT_IN_DRAFT);
    return record;
  }

  append(ref: HostedFileRef, offset: number, bytes: Uint8Array): Promise<HostedFileRecord> {
    return this.#serial(ref, async () => {
      const record = await this.get(ref);
      if (record.phase !== "importing" || !bytes.byteLength || bytes.byteLength > HOSTED_FILE_CHUNK_BYTES || !Number.isSafeInteger(offset) || offset < 0 || offset + bytes.byteLength > record.bytes)
        throw new Error("This file's saved bytes don't match. Attach it again.");
      const file = await open(this.#path(ref, "bytes"), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try {
        if (offset < record.imported) {
          await verifyRetry(file, record, offset, bytes);
          return record;
        }
        if (offset !== record.imported) throw new Error("This file hasn't finished saving. Try again.");
        let written = 0;
        while (written < bytes.byteLength) {
          const next = await file.write(bytes, written, bytes.byteLength - written, offset + written);
          if (!next.bytesWritten) throw new Error("This file couldn't be saved. Try again.");
          written += next.bytesWritten;
        }
        await file.sync();
        record.imported += written;
        await this.#save(record);
        return record;
      } finally {
        await file.close();
      }
    });
  }

  seal(ref: HostedFileRef): Promise<HostedFileRecord> {
    return this.update(ref, async (record) => {
      if (record.phase !== "importing") return record;
      const file = await open(this.#path(ref, "bytes"), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (record.imported !== record.bytes || (await file.stat()).size !== record.bytes) throw new Error("This file hasn't finished saving. Try again.");
      } finally {
        await file.close();
      }
      return { ...record, phase: "uploading" };
    });
  }

  update(ref: HostedFileRef, change: (record: HostedFileRecord) => HostedFileRecord | Promise<HostedFileRecord>): Promise<HostedFileRecord> {
    return this.#serial(ref, async () => {
      const previous = await this.get(ref);
      const next = HostedFileRecord.parse(await change(previous));
      if (next.id !== previous.id || !sameFileDraft(next, previous)) throw new Error(FILE_NOT_IN_DRAFT);
      await this.#save(next);
      return next;
    });
  }

  async source(ref: HostedFileRef): Promise<FileByteSource> {
    const record = await this.get(ref);
    if (record.imported !== record.bytes) throw new Error("This file hasn't finished saving. Try again.");
    return { bytes: record.bytes, read: (offset, length) => this.#readBytes(ref, record.bytes, offset, length) };
  }

  remove(ref: HostedFileRef): Promise<void> {
    return this.#serial(ref, async () => {
      if (!(await this.#load(ref))) return;
      await rm(this.#path(ref, "bytes"), { force: true });
      await rm(this.#path(ref, "json"), { force: true });
    });
  }

  cancel(ref: HostedFileRef): Promise<void> {
    return this.#serial(ref, async () => {
      const record = await this.get(ref);
      await rm(this.#path(ref, "bytes"), { force: true });
      await this.#save({ ...record, phase: "cancelled", failure: null });
    });
  }

  async #readBytes(ref: HostedFileRef, size: number, offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || length > HOSTED_FILE_CHUNK_BYTES || offset + length > size)
      throw new Error("Invalid file range.");
    const file = await open(this.#path(ref, "bytes"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = Buffer.alloc(length);
      const read = await file.read(bytes, 0, length, offset);
      if (read.bytesRead !== length) throw new Error("This file's saved bytes are missing. Attach it again.");
      return bytes;
    } finally {
      await file.close();
    }
  }

  async #load(ref: HostedFileRef): Promise<HostedFileRecord | null> {
    const record = await this.#read(this.#path(ref, "json"));
    if (record && !sameFileDraft(record, ref)) throw new Error(FILE_NOT_IN_DRAFT);
    return record;
  }

  async #read(filePath: string): Promise<HostedFileRecord | null> {
    const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (!file) return null;
    try {
      if ((await file.stat()).size > 32_000) throw new Error("Saved file data couldn't be read.");
      return HostedFileRecord.parse(JSON.parse(await file.readFile("utf8")) as unknown);
    } finally {
      await file.close();
    }
  }

  async #save(record: HostedFileRecord): Promise<void> {
    await mkdir(this.#directory(record.scope), { recursive: true, mode: 0o700 });
    const target = this.#path(record, "json");
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(record));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, target);
      const directory = await open(path.dirname(target), constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  #directory(scope: Pick<HostedFileRef["scope"], "apiOrigin" | "accountId">): string {
    const key = createHash("sha256")
      .update(JSON.stringify([scope.apiOrigin, scope.accountId]))
      .digest("hex");
    return path.join(this.dataDir, "hosted-files", key);
  }

  #path(ref: HostedFileRef, extension: "json" | "bytes"): string {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ref.id)) throw new Error(FILE_NOT_IN_DRAFT);
    return path.join(this.#directory(ref.scope), `${ref.id}.${extension}`);
  }

  async #serial<T>(ref: HostedFileRef, run: () => Promise<T>): Promise<T> {
    const key = this.#path(ref, "json");
    const prior = this.#pending.get(key);
    const next = Promise.resolve(prior)
      .catch(() => undefined)
      .then(run);
    this.#pending.set(key, next);
    try {
      return await next;
    } finally {
      if (this.#pending.get(key) === next) this.#pending.delete(key);
    }
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function verifyRetry(file: Awaited<ReturnType<typeof open>>, record: HostedFileRecord, offset: number, bytes: Uint8Array): Promise<void> {
  if (offset + bytes.byteLength > record.imported) throw new Error("This file hasn't finished saving. Try again.");
  const saved = Buffer.alloc(bytes.byteLength);
  const read = await file.read(saved, 0, saved.byteLength, offset);
  if (read.bytesRead !== bytes.byteLength || !saved.equals(bytes)) throw new Error("This file's saved bytes don't match. Attach it again.");
}
