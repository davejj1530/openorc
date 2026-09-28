import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { safeStorage, type UtilityProcess } from "electron";

const files = new Map([
  ["slack.secrets", "slack-secrets.enc"],
  ["memory.secrets", "memory-extraction-key.enc"],
]);
const storageError = "Cannot access protected storage. Unlock your OS keychain or secret service and retry.";

function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) throw new Error(storageError);
}

async function save(file: string, value: string, dataDir: string): Promise<void> {
  requireEncryption();
  const encrypted = safeStorage.encryptString(value);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(encrypted);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    // Make the rename durable before core removes a legacy database value.
    if (process.platform !== "win32") {
      const directory = await open(dataDir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Only the local core can access these allowlisted stores. No renderer read-secret API. */
export function installProtectedSecrets(child: UtilityProcess, dataDir: string): void {
  const pending = new Map<string, Promise<unknown>>();
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const request = message as { type?: unknown; id?: unknown; operation?: unknown; value?: unknown };
    if (typeof request.type !== "string" || !Number.isSafeInteger(request.id)) return;
    const filename = files.get(request.type);
    if (!filename) return;
    const channel = request.type;
    const file = join(dataDir, filename);
    const operation = async (): Promise<string | null> => {
      if (request.operation === "load") {
        const encrypted = await readFile(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        // A fresh profile needs no keychain access until a secret is saved.
        if (!encrypted) return null;
        requireEncryption();
        return safeStorage.decryptString(encrypted);
      }
      if (request.operation !== "save" || typeof request.value !== "string" || request.value.length > 100_000) throw new Error(storageError);
      await save(file, request.value, dataDir);
      return null;
    };
    const next = (pending.get(channel) ?? Promise.resolve()).then(operation, operation);
    pending.set(
      channel,
      next.catch(() => {}),
    );
    void next
      .then(
        (value) => child.postMessage({ type: `${channel}.result`, id: request.id, value }),
        () => child.postMessage({ type: `${channel}.result`, id: request.id, error: storageError }),
      )
      .catch(() => {}); // The utility process may have exited while storage was pending.
  });
}
