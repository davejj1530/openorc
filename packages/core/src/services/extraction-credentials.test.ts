import { describe, expect, it, vi } from "vitest";
import { ExtractionCredentials, extractionStorageError, type ProtectedSecretStore } from "./extraction-credentials.js";

class TestStore implements ProtectedSecretStore {
  value: string | null = null;
  load = vi.fn(async () => this.value);
  save = vi.fn(async (value: string) => {
    this.value = value;
  });
}
function fixture() {
  const store = new TestStore();
  return { store, credentials: new ExtractionCredentials(store) };
}

describe("protected extraction credentials", () => {
  it("saves a trimmed key and reads a cleared one as no key", async () => {
    const { store, credentials } = fixture();
    await credentials.write(" new-fixture ");
    expect(store.value).toBe("new-fixture");
    await expect(credentials.read()).resolves.toEqual({ apiKey: "new-fixture", error: null });
    await credentials.write("");
    expect(store.value).toBe("");
    await expect(new ExtractionCredentials(store).read()).resolves.toEqual({ apiKey: null, error: null });
  });

  it("reports storage failures without the key and keeps the saved value", async () => {
    const { store, credentials } = fixture();
    store.value = "protected-fixture";
    store.load.mockRejectedValueOnce(new Error("contains protected-fixture"));
    await expect(credentials.read()).resolves.toEqual({ apiKey: null, error: extractionStorageError });
    store.save.mockRejectedValue(new Error("secret in provider error"));
    for (const value of ["replacement-fixture", ""]) {
      const failure = credentials.write(value);
      await expect(failure).rejects.toThrow(extractionStorageError);
      await expect(failure).rejects.not.toThrow(/protected-fixture|replacement-fixture/);
      expect(store.value).toBe("protected-fixture");
    }
  });

  it("serializes replacement, reads, and clearing", async () => {
    const { store, credentials } = fixture();
    let release!: () => void;
    store.save.mockImplementationOnce(async (value) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      store.value = value;
    });
    const replace = credentials.write("replacement-fixture");
    const read = credentials.read();
    const clear = credentials.write("");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(store.load).not.toHaveBeenCalled();
    release();
    await replace;
    await expect(read).resolves.toEqual({ apiKey: "replacement-fixture", error: null });
    await clear;
    expect(store.value).toBe("");
  });

  it("fails closed when no store is supplied and does not poison later calls", async () => {
    const credentials = new ExtractionCredentials();
    await expect(credentials.write("new-fixture")).rejects.toThrow(extractionStorageError);
    await expect(credentials.read()).resolves.toEqual({ apiKey: null, error: null });
  });
});
