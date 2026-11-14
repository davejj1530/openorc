import type { OrganizationBillingPage, OrganizationBillingStatus } from "@openorc/protocol";

export interface OrganizationBillingViewState {
  status: OrganizationBillingStatus | null;
  loading: boolean;
  opening: boolean;
  uncertain: boolean;
  error: string | null;
}
export interface OrganizationBillingViewDeps {
  current(): boolean;
  get(): Promise<OrganizationBillingStatus>;
  open(target: OrganizationBillingPage): Promise<OrganizationBillingStatus>;
  leave(): Promise<OrganizationBillingStatus>;
}

export class OrganizationBillingView {
  #snapshot: OrganizationBillingViewState = { status: null, loading: false, opening: false, uncertain: false, error: null };
  readonly #listeners = new Set<() => void>();
  #reading = 0;
  #epoch = 0;
  #writing: Promise<void> | null = null;
  #closed = false;
  constructor(private readonly deps: OrganizationBillingViewDeps) {}
  getSnapshot = (): OrganizationBillingViewState => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async refresh(): Promise<void> {
    if (!this.#current()) return;
    const reading = ++this.#reading;
    this.#publish({ loading: true });
    try {
      const status = await this.deps.get();
      if (this.#current() && reading === this.#reading) this.#publish({ status, error: status.error, uncertain: false });
    } catch (error) {
      if (this.#current() && reading === this.#reading) this.#publish({ error: words(error) });
    } finally {
      if (this.#current() && reading === this.#reading) this.#publish({ loading: false });
    }
  }

  async open(target: OrganizationBillingPage): Promise<void> {
    if (!this.#current() || this.#snapshot.uncertain) return;
    if (this.#writing) return this.#writing;
    const writing = this.#open(target);
    this.#writing = writing;
    try {
      await writing;
    } finally {
      if (this.#writing === writing) this.#writing = null;
    }
  }

  async #open(target: OrganizationBillingPage): Promise<void> {
    const epoch = ++this.#epoch;
    ++this.#reading;
    this.#publish({ opening: true, loading: false, error: null });
    try {
      const status = await this.deps.open(target);
      if (this.#current() && epoch === this.#epoch) {
        ++this.#reading;
        this.#publish({ status, error: status.error, loading: false });
      }
    } catch (error) {
      if (this.#current() && epoch === this.#epoch) {
        this.#publish({ error: words(error), uncertain: true });
        await this.refresh();
        if (this.#current() && epoch === this.#epoch && !this.#snapshot.uncertain && !this.#snapshot.status?.payment) this.#publish({ error: words(error) });
      }
    } finally {
      if (this.#current() && epoch === this.#epoch) this.#publish({ opening: false });
    }
  }

  async leave(): Promise<void> {
    if (!this.#current()) return;
    const epoch = ++this.#epoch;
    ++this.#reading;
    try {
      const status = await this.deps.leave();
      if (this.#current() && epoch === this.#epoch) this.#publish({ status, opening: false, loading: false, error: status.error });
    } catch (error) {
      if (this.#current() && epoch === this.#epoch) this.#publish({ opening: false, loading: false, error: words(error) });
    }
  }

  revoke(): void {
    this.#closed = true;
    ++this.#epoch;
    ++this.#reading;
    this.#publish({ status: null, loading: false, opening: false, uncertain: false, error: null });
  }

  close(): void {
    const watching = this.#snapshot.opening || this.#snapshot.status?.payment?.watching;
    if (watching && this.deps.current()) void this.deps.leave().catch(() => undefined);
    this.revoke();
    this.#listeners.clear();
  }

  #current(): boolean {
    if (this.#closed) return false;
    if (this.deps.current()) return true;
    this.revoke();
    return false;
  }

  #publish(update: Partial<OrganizationBillingViewState>): void {
    this.#snapshot = { ...this.#snapshot, ...update };
    this.#listeners.forEach((listener) => listener());
  }
}

const words = (error: unknown) => (error instanceof Error ? error.message : "The seats could not be read.");
