import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, statSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { SPEECH_MODELS, type SpeechModel, type SpeechModelState } from "../shared/dictation";

export type FetchModel = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

/** How often a download says how far it is: often enough for a moving bar, seldom enough to cost nothing. */
const REPORT_MS = 200;

class DownloadRefused extends Error {}

const reasonOf = (error: unknown) => (error instanceof DownloadRefused ? error.message : "The download stopped before it finished.");

/**
 * The speech models on this computer, one file each in a folder of the profile. A download is written beside its
 * place and moved in only once every byte matches the model's hash, so a file that is there is whole. What an
 * interrupted download left is continued rather than fetched again.
 */
export class SpeechModels {
  private readonly downloads = new Map<string, { received: number; stop: AbortController }>();
  private readonly failures = new Map<string, string>();

  constructor(
    private readonly dir: string,
    private readonly fetch: FetchModel,
    private readonly changed: (model: string, state: SpeechModelState) => void,
  ) {}

  file(model: SpeechModel): string {
    return join(this.dir, model.file);
  }

  state(model: SpeechModel): SpeechModelState {
    const download = this.downloads.get(model.id);
    if (download) return { phase: "downloading", received: download.received };
    if (this.here(model)) return { phase: "ready" };
    const reason = this.failures.get(model.id);
    return reason ? { phase: "failed", reason } : { phase: "missing" };
  }

  states(): Record<string, SpeechModelState> {
    return Object.fromEntries(SPEECH_MODELS.map((model) => [model.id, this.state(model)]));
  }

  download(model: SpeechModel): void {
    if (this.downloads.has(model.id) || this.here(model)) return;
    const download = { received: 0, stop: new AbortController() };
    this.downloads.set(model.id, download);
    this.failures.delete(model.id);
    this.changed(model.id, this.state(model));
    void this.receive(model, download)
      .catch((error: unknown) => {
        if (!download.stop.signal.aborted) this.failures.set(model.id, reasonOf(error));
      })
      .finally(() => {
        this.downloads.delete(model.id);
        this.changed(model.id, this.state(model));
      });
  }

  cancel(model: SpeechModel): void {
    this.downloads.get(model.id)?.stop.abort();
  }

  async remove(model: SpeechModel): Promise<void> {
    this.cancel(model);
    await Promise.all([rm(this.file(model), { force: true }), rm(this.part(model), { force: true })]);
    this.failures.delete(model.id);
    this.changed(model.id, this.state(model));
  }

  private part(model: SpeechModel): string {
    return `${this.file(model)}.part`;
  }

  private here(model: SpeechModel): boolean {
    try {
      return statSync(this.file(model)).size === model.bytes;
    } catch {
      return false;
    }
  }

  private async receive(model: SpeechModel, download: { received: number; stop: AbortController }): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const part = this.part(model);
    let hash = createHash("sha256");
    let kept = await stat(part).then(
      (file) => (file.size < model.bytes ? file.size : 0),
      () => 0,
    );
    if (kept) for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
    const response = await this.fetch(model.url, { signal: download.stop.signal, headers: kept ? { Range: `bytes=${kept}-` } : {} });
    if (!response.ok || !response.body) throw new DownloadRefused(`The download answered ${response.status}.`);
    // A server that ignores the range sends the whole file, which starts the part over.
    if (kept && response.status !== 206) {
      kept = 0;
      hash = createHash("sha256");
    }
    download.received = kept;
    let reported = 0;
    const report = (chunk: Uint8Array) => {
      hash.update(chunk);
      download.received += chunk.length;
      if (Date.now() - reported < REPORT_MS) return;
      reported = Date.now();
      this.changed(model.id, { phase: "downloading", received: download.received });
    };
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          report(chunk);
          yield chunk;
        }
      },
      createWriteStream(part, { flags: kept ? "a" : "w" }),
      { signal: download.stop.signal },
    );
    if (download.received !== model.bytes || hash.digest("hex") !== model.sha256) {
      await rm(part, { force: true });
      throw new DownloadRefused("The download did not match the speech model.");
    }
    await rename(part, this.file(model));
  }
}
