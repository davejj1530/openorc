import { HOSTED_FILE_MAX_BYTES, type HostedDraftFile, type HostedFileDraft, type HostedFileRef } from "@openorc/protocol";
import { HostedAttachmentStore, hostedAttachmentKey, type HostedAttachmentSource } from "./hosted-attachment-store";
import { transferHostedAttachment, type HostedAttachmentPort } from "./hosted-attachment-transfer";

type Dependencies = { store: HostedAttachmentStore; port: HostedAttachmentPort; encode?: (blob: Blob) => Promise<string> };
type Work = { ref: HostedFileRef; retry: boolean };
const MISSING = "This file's saved bytes are missing. Attach it again.";

/** One window's byte-import queue outlives composer mounts. Core owns the separate, shared upload queue. */
export class HostedAttachmentImports {
  readonly #listeners = new Set<() => void>();
  readonly #queue = new Map<string, Work>();
  readonly #versions = new Map<string, number>();
  readonly #failures = new Map<string, string>();
  readonly #unstored = new Map<string, HostedAttachmentSource>();
  #draining: Promise<void> | null = null;
  #active: string | null = null;
  #closed = false;
  #selectedAt = 0;
  constructor(private readonly deps: Dependencies) {}

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async capture(draft: HostedFileDraft): Promise<HostedFileDraft> {
    return { ...draft, scope: await this.deps.port.capture({ scope: draft.scope }) };
  }

  async add(draft: HostedFileDraft, blob: Blob, name: string): Promise<HostedFileRef> {
    const ref = { ...draft, id: crypto.randomUUID() };
    const file: HostedDraftFile = {
      id: ref.id,
      name,
      bytes: blob.size,
      mime: blob.type,
      imported: 0,
      selectedAt: (this.#selectedAt = Math.max(Date.now(), this.#selectedAt + 1)),
      state: { kind: "importing" },
    };
    const source: HostedAttachmentSource = { draft, file, blob: blob.size > HOSTED_FILE_MAX_BYTES || blob.size === 0 ? null : blob, transfer: { kind: "pending" } };
    try {
      await this.deps.store.put(source);
      this.#enqueue(ref);
    } catch (error) {
      const failed = { ...source, transfer: failure(error) };
      this.#unstored.set(key(ref), failed);
    }
    this.#changed();
    return ref;
  }

  async files(draft: HostedFileDraft): Promise<HostedDraftFile[]> {
    const [local, remote] = await Promise.all([this.deps.store.list(draft), this.deps.port.state(draft)]);
    const sources = [...local, ...[...this.#unstored.values()].filter((source) => hostedAttachmentKey(source.draft) === hostedAttachmentKey(draft))];
    const rows = new Map(remote.files.map((file) => [file.id, file]));
    for (const source of sources) {
      const ref = { ...draft, id: source.file.id };
      const message = this.#failures.get(key(ref));
      const shown = showSource(source, rows.get(ref.id), message);
      if (shown) rows.set(ref.id, shown);
      else rows.delete(ref.id);
      if (source.transfer.kind === "stored" && !shown) await this.deps.store.remove(ref);
      if (source.transfer.kind === "pending" || source.transfer.kind === "removing" || source.transfer.kind === "accepted") this.#enqueue(ref);
    }
    return [...rows.values()].sort((a, b) => a.selectedAt - b.selectedAt);
  }

  async retry(ref: HostedFileRef): Promise<void> {
    try {
      const unstored = this.#unstored.get(key(ref));
      if (unstored) {
        await this.deps.store.put(unstored);
        this.#unstored.delete(key(ref));
      }
      this.#failures.delete(key(ref));
      await this.#retain(ref);
      await this.deps.store.change(ref, (source) => (source.transfer.kind === "removing" || source.transfer.kind === "accepted" ? source : { ...source, transfer: { kind: "pending" } }));
      this.#enqueue(ref, true);
    } catch (error) {
      await this.#failed(ref, error);
    }
    this.#changed();
  }

  async remove(ref: HostedFileRef): Promise<void> {
    this.#versions.set(key(ref), (this.#versions.get(key(ref)) ?? 0) + 1);
    this.#unstored.delete(key(ref));
    this.#failures.delete(key(ref));
    await this.#retain(ref);
    await this.deps.store.change(ref, (source) => ({ ...source, blob: null, transfer: { kind: "removing" } }));
    this.#enqueue(ref, false, true);
    this.#changed();
  }

  async accepted(ref: HostedFileRef): Promise<void> {
    await this.#retain(ref);
    await this.deps.store.change(ref, (source) => ({ ...source, blob: null, transfer: { kind: "accepted" } }));
    this.#enqueue(ref, false, true);
    this.#changed();
  }

  async idle(): Promise<void> {
    while (this.#draining) await this.#draining;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#queue.clear();
    await this.#draining;
  }

  async #retain(ref: HostedFileRef): Promise<void> {
    if (await this.deps.store.get(ref)) return;
    const file = (await this.deps.port.state(ref)).files.find((file) => file.id === ref.id);
    if (file) await this.deps.store.put({ draft: { scope: ref.scope, draftKey: ref.draftKey }, file, blob: null, transfer: { kind: "stored" } });
  }

  #enqueue(ref: HostedFileRef, retry = false, replaceActive = false): void {
    const id = key(ref);
    if (this.#closed || this.#failures.has(id) || (id === this.#active && !replaceActive)) return;
    this.#queue.set(id, { ref, retry });
    if (this.#draining) return;
    this.#draining = this.#drain().finally(() => {
      this.#draining = null;
      const next = this.#queue.values().next().value;
      if (next) this.#enqueue(next.ref, next.retry);
    });
  }

  async #drain(): Promise<void> {
    while (this.#queue.size && !this.#closed) {
      const next = this.#queue.entries().next().value;
      if (!next) return;
      const [id, work] = next;
      this.#queue.delete(id);
      this.#active = id;
      const version = this.#versions.get(id) ?? 0;
      const current = () => !this.#closed && (this.#versions.get(id) ?? 0) === version;
      try {
        await this.#transfer(work, current);
      } catch (error) {
        if (current()) await this.#failed(work.ref, error);
      } finally {
        this.#active = null;
        this.#changed();
      }
    }
  }

  async #transfer({ ref, retry }: Work, current: () => boolean): Promise<void> {
    const source = await this.deps.store.get(ref);
    if (!source || !current()) return;
    const action = source.transfer.kind;
    if (action === "removing" || action === "accepted") {
      const state = await this.deps.port.state(source.draft);
      if (state.files.some((file) => file.id === ref.id)) await this.deps.port[action === "removing" ? "remove" : "accepted"](ref);
      await this.deps.store.remove(ref);
      return;
    }
    if (action !== "pending") return;
    const finished = await transferHostedAttachment({ source, port: this.deps.port, current, retry, encode: this.deps.encode });
    if (finished) await this.deps.store.change(ref, (row) => (current() && row.transfer.kind === "pending" ? { ...row, blob: null, transfer: { kind: "stored" } } : row));
  }

  async #failed(ref: HostedFileRef, error: unknown): Promise<void> {
    const failed = failure(error);
    this.#failures.set(key(ref), failed.message);
    await this.deps.store.change(ref, (source) => (source.transfer.kind === "pending" ? { ...source, transfer: failed } : source)).catch(() => undefined);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}

function key(ref: HostedFileRef): string {
  return `${hostedAttachmentKey(ref)}:${ref.id}`;
}

function failure(error: unknown): Extract<HostedAttachmentSource["transfer"], { kind: "failed" }> {
  return { kind: "failed", message: error instanceof Error ? error.message : "This file couldn't be saved. Try again." };
}

function showSource(source: HostedAttachmentSource, remote: HostedDraftFile | undefined, refused?: string): HostedDraftFile | null {
  const phase = source.transfer;
  if (phase.kind === "accepted") return null;
  if (phase.kind === "removing" && !refused) return null;
  if (phase.kind === "stored" && !remote) return null;
  const file = remote ?? source.file;
  const message = refused ?? (phase.kind === "failed" ? phase.message : undefined);
  return message ? { ...file, state: { kind: "failed", message, retryable: message !== MISSING } } : file;
}
