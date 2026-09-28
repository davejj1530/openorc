import type { ProtectedSecretStore } from "@openorc/core";

type Channel = "slack.secrets" | "memory.secrets";
interface Pending {
  channel: Channel;
  resolve(value: string | null): void;
  reject(error: Error): void;
}

/** Correlates private main/core messages. Credential values never enter renderer RPC. */
export class ProtectedSecretsClient {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly send: (message: unknown) => void) {}

  store(channel: Channel): ProtectedSecretStore {
    return {
      load: () => this.request(channel, "load"),
      save: async (value) => {
        await this.request(channel, "save", value);
      },
    };
  }

  private request(channel: Channel, operation: "load" | "save", value?: string): Promise<string | null> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timeout);
        this.pending.delete(id);
      };
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Protected storage timed out. Check your OS keychain and retry."));
      }, 60_000);
      this.pending.set(id, {
        channel,
        resolve: (result) => {
          finish();
          resolve(result);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      });
      try {
        this.send({ type: channel, id, operation, value });
      } catch {
        finish();
        reject(new Error("Protected storage is unavailable. Restart the app and retry."));
      }
    });
  }

  receive(message: unknown): boolean {
    if (!message || typeof message !== "object") return false;
    const result = message as { type?: unknown; id?: unknown; value?: unknown; error?: unknown };
    if (result.type !== "slack.secrets.result" && result.type !== "memory.secrets.result") return false;
    if (typeof result.id !== "number") return true;
    const request = this.pending.get(result.id);
    if (!request || result.type !== `${request.channel}.result`) return true;
    if (result.error || (result.value !== null && typeof result.value !== "string")) {
      request.reject(new Error("Cannot access protected storage. Unlock your OS keychain or secret service and retry."));
    } else request.resolve(result.value);
    return true;
  }
}
