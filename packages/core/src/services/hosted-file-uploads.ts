import { randomUUID } from "node:crypto";
import type { Hosted } from "@openorc/hosted";
import { HostedFileStore } from "./hosted-file-store.js";
import type { HostedFileRecord, HostedFileRef, NewHostedFile } from "./hosted-file-record.js";

const EXPIRED = new Set(["This upload expired. Retry to upload the file again.", "That upload expired. Attach the file again."]);
const CLOSED = "The app closed before this file finished uploading.";
type Dependencies = { store: HostedFileStore; account(): Hosted | null; changed(): void };

/** One durable draft file uploads at a time, regardless of how many windows are open. */
export class HostedFileUploads {
  readonly #queue = new Map<string, HostedFileRef>();
  readonly #progress = new Map<string, number>();
  readonly #nextCancel = new Map<string, number>();
  readonly #failures = new Map<string, string>();
  #active: { key: string; control: AbortController } | null = null;
  #draining: Promise<void> | null = null;
  #closed = false;
  #lastNotice = 0;

  constructor(private readonly deps: Dependencies) {}

  async begin(input: NewHostedFile): Promise<HostedFileRecord> {
    const scope = await this.#account(input).files.capture(input.scope);
    const record = await this.deps.store.begin({ ...input, scope });
    this.deps.changed();
    return record;
  }

  async state(input: Pick<HostedFileRef, "scope" | "draftKey">): Promise<{ files: HostedFileRecord[]; progress: Record<string, number> }> {
    this.#account(input);
    const files = await this.deps.store.list(input);
    this.#account(input);
    for (const file of files) if (file.phase === "uploading" || file.phase === "cancelled") this.#enqueue(file);
    return {
      files: files.filter((file) => file.phase !== "cancelled").map((file) => this.#visible(file)),
      progress: Object.fromEntries(files.map((file) => [file.id, this.#progress.get(this.#key(file)) ?? completedBytes(file)])),
    };
  }

  async append(input: HostedFileRef, offset: number, bytes: Uint8Array): Promise<number> {
    this.#account(input);
    return (await this.deps.store.append(input, offset, bytes)).imported;
  }

  async finish(input: HostedFileRef): Promise<void> {
    this.#account(input);
    const record = await this.deps.store.seal(input);
    if (record.phase === "uploading") this.#enqueue(record);
    this.deps.changed();
  }

  async retry(input: HostedFileRef): Promise<void> {
    this.#account(input);
    this.#failures.delete(this.#key(input));
    const record = await this.deps.store.update(input, (row) => {
      if (row.phase !== "failed") return row;
      if (!row.failure?.retryable) throw new Error(row.failure?.message ?? "This file can't be uploaded.");
      const expired = EXPIRED.has(row.failure.message);
      return {
        ...row,
        phase: row.imported === row.bytes ? "uploading" : "importing",
        failure: null,
        ...(expired && { requestId: randomUUID(), plan: null, completedParts: [], file: null, started: false }),
      };
    });
    if (record.phase === "uploading") this.#enqueue(record);
    this.deps.changed();
  }

  async remove(input: HostedFileRef): Promise<void> {
    this.#account(input);
    const key = this.#key(input);
    if (this.#active?.key === key) this.#active.control.abort(new Error("Removed from this draft."));
    await this.deps.store.cancel(input);
    this.#progress.delete(key);
    this.#failures.delete(key);
    this.#nextCancel.delete(key);
    this.#enqueue(input, true);
    this.deps.changed();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#queue.clear();
    this.#active?.control.abort(new Error(CLOSED));
    await this.#draining;
  }

  #enqueue(ref: HostedFileRef, removing = false): void {
    const key = this.#key(ref);
    if (this.#closed || (!removing && this.#active?.key === key) || this.#failures.has(key) || (this.#nextCancel.get(key) ?? 0) > Date.now()) return;
    this.#queue.set(key, ref);
    this.#work();
  }

  #work(): void {
    if (this.#draining) return;
    this.#draining = this.#drain().finally(() => {
      this.#draining = null;
      if (this.#queue.size && !this.#closed) this.#work();
    });
  }

  async #drain(): Promise<void> {
    while (this.#queue.size && !this.#closed) {
      const [key, ref] = this.#queue.entries().next().value!;
      this.#queue.delete(key);
      const control = new AbortController();
      this.#active = { key, control };
      try {
        const record = await this.deps.store.get(ref);
        if (record.phase === "cancelled") await this.#cancel(record, control.signal);
        else if (record.phase === "uploading") await this.#upload(record, control.signal);
      } catch (error) {
        try {
          await this.#failed(ref, error);
        } catch {
          this.#failures.set(key, "This file couldn't be saved. Try again.");
        }
      } finally {
        this.#active = null;
        this.#progress.delete(key);
        this.deps.changed();
      }
    }
  }

  async #upload(record: HostedFileRecord, signal: AbortSignal): Promise<void> {
    const files = this.#account(record).files;
    await files.capture(record.scope);
    const source = await this.deps.store.source(record);
    if (!record.plan) {
      record = await this.deps.store.update(record, (row) => ({ ...row, started: true }));
      const plan = await files.start(record.scope, { name: record.name, bytes: record.bytes, requestId: record.requestId }, signal);
      record = await this.deps.store.update(record, (row) => ({ ...row, plan }));
    }
    const plan = record.plan!;
    for (let part = 1; part <= plan.parts; part++) {
      if (record.completedParts.includes(part)) continue;
      const completed = completedBytes(record);
      await files.part(record.scope, plan, part, source, { signal, progress: (sent) => this.#showProgress(record, completed + sent) });
      record = await this.deps.store.update(record, (row) => ({ ...row, completedParts: [...row.completedParts, part] }));
    }
    const file = await files.complete(record.scope, plan.id, signal);
    await this.deps.store.update(record, (row) => (row.phase === "cancelled" ? row : { ...row, file, phase: "ready", failure: null }));
  }

  async #cancel(record: HostedFileRecord, signal: AbortSignal): Promise<void> {
    const files = this.#account(record).files;
    const plan = record.plan ?? (record.started ? await files.start(record.scope, { name: record.name, bytes: record.bytes, requestId: record.requestId }, signal) : null);
    if (plan) await files.cancel(record.scope, plan.id, signal);
    await this.deps.store.remove(record);
    this.#nextCancel.delete(this.#key(record));
  }

  async #failed(ref: HostedFileRef, error: unknown): Promise<void> {
    if (this.#closed) return;
    const message = failureWords(error);
    const record = await this.deps.store.get(ref);
    if (record.phase === "cancelled") {
      if (EXPIRED.has(message)) await this.deps.store.remove(record);
      else if (message !== "Removed from this draft.") this.#nextCancel.set(this.#key(ref), Date.now() + 30_000);
      return;
    }
    const retryable = message !== "This file's saved bytes are missing. Attach it again.";
    await this.deps.store.update(record, (row) => (row.phase === "cancelled" ? row : { ...row, phase: "failed", failure: { message, retryable } }));
  }

  #showProgress(ref: HostedFileRef, bytes: number): void {
    this.#progress.set(this.#key(ref), bytes);
    if (Date.now() - this.#lastNotice < 100) return;
    this.#lastNotice = Date.now();
    this.deps.changed();
  }

  #visible(record: HostedFileRecord): HostedFileRecord {
    const message = this.#failures.get(this.#key(record));
    return message ? { ...record, phase: "failed", failure: { message, retryable: true } } : record;
  }

  #account(ref: Pick<HostedFileRef, "scope">): Hosted {
    const account = this.deps.account();
    const status = account?.spaces.status();
    if (!account || this.#closed || status?.state !== "ready" || status.userId !== ref.scope.accountId || status.apiOrigin !== ref.scope.apiOrigin)
      throw new Error("Your OpenOrc session changed. Try again.");
    return account;
  }

  #key(ref: HostedFileRef): string {
    return JSON.stringify([ref.scope.apiOrigin, ref.scope.accountId, ref.id]);
  }
}

function failureWords(error: unknown): string {
  if (!(error instanceof Error)) return "This file didn't finish uploading. Retry or remove it.";
  if (!("code" in error) || !("syscall" in error)) return error.message;
  if (error.code === "ENOENT") return "This file's saved bytes are missing. Attach it again.";
  return typeof error.code === "string" && /^E[A-Z]+$/.test(error.code) ? "This file couldn't be saved. Try again." : error.message;
}

function completedBytes(record: HostedFileRecord): number {
  const plan = record.plan;
  if (!plan) return 0;
  return record.completedParts.reduce((total, part) => total + Math.min(plan.partBytes, record.bytes - (part - 1) * plan.partBytes), 0);
}
