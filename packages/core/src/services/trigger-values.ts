import type { ProtectedSecretStore } from "./extraction-credentials.js";

type Values = Record<string, Record<string, string>>;

/**
 * The values trigger programs read from their environment, such as tokens, by program: kept encrypted by the system
 * and given to a program only as it starts, never written into its folder.
 */
export class TriggerValues {
  private kept: Promise<Values> | null = null;

  constructor(private readonly store: ProtectedSecretStore | undefined) {}

  /** One program's values by name. */
  async of(id: string): Promise<Record<string, string>> {
    return (await this.all())[id] ?? {};
  }

  /** Sets one of a program's values; an empty one is removed. */
  async set(id: string, name: string, value: string): Promise<void> {
    if (!this.store) throw new Error("Values can't be kept on this computer.");
    const all = await this.all();
    const own = { ...all[id] };
    if (value) own[name] = value;
    else delete own[name];
    const next = { ...all, [id]: own };
    await this.store.save(JSON.stringify(next));
    this.kept = Promise.resolve(next);
  }

  private all(): Promise<Values> {
    // A read that failed, as with the keychain locked, is tried again the next time.
    this.kept ??= (this.store?.load() ?? Promise.resolve(null))
      .then((text) => (text ? (JSON.parse(text) as Values) : {}))
      .catch((error: unknown) => {
        this.kept = null;
        throw error;
      });
    return this.kept;
  }
}
