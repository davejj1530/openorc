/** What the app keeps as text by key: MMKV on the phone, a map in tests. */
export interface KeyValue {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * The app's kept values, with a scratch layer for the demo: while it scratches, writes stay in memory over what is
 * kept and reads see them, so nothing the demo does reaches the disk, even if the app is killed. Ending the scratch
 * drops it, and whoever holds a kept value in memory reads it again.
 */
export class ScratchStore implements KeyValue {
  /** A value written while scratching, or null for one removed. */
  private scratched: Map<string, string | null> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly kept: KeyValue) {}

  getString(key: string): string | undefined {
    const scratched = this.scratched?.get(key);
    if (scratched !== undefined) return scratched ?? undefined;
    return this.kept.getString(key);
  }

  set(key: string, value: string): void {
    if (this.scratched) this.scratched.set(key, value);
    else this.kept.set(key, value);
  }

  remove(key: string): void {
    if (this.scratched) this.scratched.set(key, null);
    else this.kept.remove(key);
  }

  /** Starts scratching over what is kept, or drops what was scratched. */
  scratch(on: boolean): void {
    if (on) {
      this.scratched ??= new Map();
      return;
    }
    const had = this.scratched;
    this.scratched = null;
    if (had?.size) for (const listener of this.listeners) listener();
  }

  /** Hears the scratch dropped with something in it. */
  onDropped(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
