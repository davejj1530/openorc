import type { Hosted } from "@openorc/hosted";
import type { HostedDraftFile, HostedFileDraft, HostedFileRef, HostedFileScope, HostedFilesRpcResults } from "@openorc/protocol";
import { HostedAssets } from "./hosted-assets.js";
import { HostedFileStore } from "./hosted-file-store.js";
import { HostedFileUploads } from "./hosted-file-uploads.js";
import { hostedFilePreview } from "./hosted-file-preview.js";
import type { HostedFileRecord, NewHostedFile } from "./hosted-file-record.js";
import type { OpenOrcOptions } from "../options.js";
import type { Transport } from "../transport.js";
import { restoreHostedFiles } from "./hosted-file-restore.js";

type Dependencies = { dataDir: string; account(): Hosted | null; changed(): void; chooseDownload?: (name: string) => Promise<string | null> };

export function hostedFilesFor(options: Pick<OpenOrcOptions, "dataDir" | "chooseDownload">, account: () => Hosted | null, windows: Transport): HostedFiles {
  return new HostedFiles({ dataDir: options.dataDir, account, chooseDownload: options.chooseDownload, changed: () => windows.push({ type: "invalidate", keys: ["hostedFiles"] }) });
}

/** The window-facing file service hides upload URLs, disk locations and private receipts. */
export class HostedFiles {
  readonly #store: HostedFileStore;
  readonly #uploads: HostedFileUploads;
  readonly assets: HostedAssets;

  constructor(private readonly deps: Dependencies) {
    this.#store = new HostedFileStore(deps.dataDir);
    this.#uploads = new HostedFileUploads({ ...deps, store: this.#store });
    this.assets = new HostedAssets(deps);
  }

  /** The account left an organization: its drafts' files are no longer theirs to send, so they go from this Mac. */
  async forgetSpace(left: { apiOrigin: string; accountId: string; spaceId: string }): Promise<void> {
    await this.#store.forgetSpace(left);
    this.deps.changed();
  }

  capture(scope: HostedFileScope): Promise<HostedFileScope> {
    const account = this.deps.account();
    if (!account) throw new Error("Sign in to OpenOrc to attach files.");
    return account.files.capture(scope);
  }

  async availability(scope: HostedFileScope): Promise<HostedFilesRpcResults["hostedFiles.availability"]> {
    const captured = await this.capture(scope);
    const account = this.deps.account();
    if (!account) throw new Error("Sign in to OpenOrc to attach files.");
    return account.files.availability(captured);
  }

  async restore(input: HostedFileDraft & { paths: string[] }): Promise<Record<string, never>> {
    const scope = await this.capture(input.scope);
    const account = this.deps.account();
    if (!account) throw new Error("Sign in to OpenOrc to attach files.");
    await restoreHostedFiles(this.#store, account.files, { ...input, scope });
    this.deps.changed();
    return {};
  }

  async state(input: HostedFileDraft): Promise<HostedFilesRpcResults["hostedFiles.state"]> {
    const scope = await this.capture(input.scope);
    const state = await this.#uploads.state({ ...input, scope });
    return { files: state.files.map((record) => draftFile(record, state.progress[record.id] ?? 0)) };
  }

  async begin(input: NewHostedFile): Promise<HostedDraftFile> {
    return draftFile(await this.#uploads.begin(input), 0);
  }

  async append(input: HostedFileRef & { offset: number; data: string }): Promise<{ imported: number }> {
    return { imported: await this.#uploads.append(input, input.offset, Buffer.from(input.data, "base64")) };
  }

  async finish(input: HostedFileRef): Promise<Record<string, never>> {
    await this.#uploads.finish(input);
    return {};
  }

  async retry(input: HostedFileRef): Promise<Record<string, never>> {
    await this.#uploads.retry(input);
    return {};
  }

  async remove(input: HostedFileRef): Promise<Record<string, never>> {
    await this.#uploads.remove(input);
    return {};
  }

  async accepted(input: HostedFileRef): Promise<Record<string, never>> {
    await this.capture(input.scope);
    const record = (await this.#store.list(input)).find((row) => row.id === input.id);
    if (!record) return {};
    if (record.phase !== "ready") throw new Error("This file hasn't finished uploading.");
    await this.#store.remove(input);
    this.deps.changed();
    return {};
  }

  async preview(input: HostedFileRef): Promise<HostedFilesRpcResults["hostedFiles.preview"]> {
    await this.capture(input.scope);
    const preview = await hostedFilePreview(this.#store, input);
    await this.capture(input.scope);
    return preview;
  }

  close(): Promise<void> {
    return this.#uploads.close();
  }
}

function draftFile(record: HostedFileRecord, sent: number): HostedDraftFile {
  const { id, name, bytes, mime, selectedAt, imported } = record;
  let state: HostedDraftFile["state"];
  if (record.phase === "ready" && record.file) state = { kind: "ready", file: record.file };
  else if (record.phase === "uploading") state = { kind: "uploading", sent };
  else if (record.phase === "importing") state = { kind: "importing" };
  else state = { kind: "failed", message: record.failure?.message ?? "This file didn't finish uploading. Retry or remove it.", retryable: record.failure?.retryable ?? true };
  return { id, name, bytes, mime, selectedAt, imported, state };
}
