/** Main owns encryption. The core only sees this fixed-purpose protected store. */
export interface ProtectedSecretStore {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
}

export const extractionStorageError = "Cannot access protected memory storage. Unlock your OS keychain or secret service and retry.";

export interface ExtractionCredential {
  apiKey: string | null;
  error: string | null;
}

/** The memory API key, kept only in main's protected store and read and written one operation at a time. */
export class ExtractionCredentials {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly store?: ProtectedSecretStore) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => {});
    return next;
  }

  read(): Promise<ExtractionCredential> {
    return this.serialize(async () => {
      if (!this.store) return { apiKey: null, error: null };
      try {
        // An encrypted empty string records an intentional clear.
        return { apiKey: (await this.store.load()) || null, error: null };
      } catch {
        return { apiKey: null, error: extractionStorageError };
      }
    });
  }

  write(value: string): Promise<void> {
    return this.serialize(async () => {
      try {
        if (!this.store) throw new Error(extractionStorageError);
        await this.store.save(value.trim());
      } catch {
        // Neither provider errors nor OS errors may carry the credential to RPC/logs.
        throw new Error(extractionStorageError);
      }
    });
  }
}
