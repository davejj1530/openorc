export type HostedAssetState = { kind: "loading" } | { kind: "empty" } | { kind: "ready"; url: string } | { kind: "failed"; message: string };
type Raster = { contentType: string; data: string };

/** A view owns one small object URL. Late reads cannot republish it after access changes or the view closes. */
export class HostedAssetLease {
  #state: HostedAssetState = { kind: "loading" };
  #version = 0;
  #closed = false;
  readonly #listeners = new Set<() => void>();
  readonly #invalidated = new Set<() => void>();
  constructor(private readonly deps: { read(): Promise<Raster | null>; create(image: Raster): string; revoke(url: string): void }) {}

  getSnapshot = (): HostedAssetState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  onInvalidated = (listener: () => void): (() => void) => {
    this.#invalidated.add(listener);
    return () => this.#invalidated.delete(listener);
  };

  start(): void {
    this.#closed = false;
    this.refresh();
  }

  refresh = (): void => {
    if (this.#closed) return;
    const version = ++this.#version;
    this.#release();
    this.#set({ kind: "loading" });
    void this.deps
      .read()
      .then((image) => {
        if (this.#closed || version !== this.#version) return;
        this.#set(image ? { kind: "ready", url: this.deps.create(image) } : { kind: "empty" });
      })
      .catch((error: unknown) => {
        if (this.#closed || version !== this.#version) return;
        this.#set({ kind: "failed", message: error instanceof Error ? error.message : "This image couldn't be opened. Try again." });
      });
  };

  failed = (): void => {
    ++this.#version;
    this.#release();
    this.#set({ kind: "failed", message: "This image couldn't be opened. Try again." });
  };

  close(): void {
    this.#closed = true;
    ++this.#version;
    this.#release();
    this.#state = { kind: "empty" };
  }

  #release(): void {
    if (this.#state.kind === "ready") this.deps.revoke(this.#state.url);
    for (const close of this.#invalidated) close();
  }

  #set(state: HostedAssetState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
