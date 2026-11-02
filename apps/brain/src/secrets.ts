import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { brainKeyCheck, keyCheckMatches, openSecret, sealSecret, type BrainKey } from "@openorc/cloud";
import type { OpenOrcOptions, ProtectedSecretStore } from "@openorc/core";

/** The options of OpenOrcOptions that are secret stores. Derived, so a new one breaks this build until the brain places it. */
type SecretOption = {
  [K in keyof OpenOrcOptions]-?: NonNullable<OpenOrcOptions[K]> extends ProtectedSecretStore ? (ProtectedSecretStore extends NonNullable<OpenOrcOptions[K]> ? K : never) : never;
}[keyof OpenOrcOptions];

/** Each secret store's channel on the brain, or null where the brain keeps none. */
export const BRAIN_SECRETS = {
  remoteSecrets: "remote",
  pushSecrets: "push",
  claudeCloudSecrets: "claude-cloud",
  codexCloudSecrets: "codex-cloud",
  memorySecrets: "memory",
  githubSecrets: "github",
  // The Vercel connection arrives with every start and is held in memory only.
  cloudSecrets: null,
  // Slack stays on the Mac.
  slackSecrets: null,
} as const satisfies Record<SecretOption, string | null>;

type Sealed = { [K in keyof typeof BRAIN_SECRETS as (typeof BRAIN_SECRETS)[K] extends string ? K : never]: ProtectedSecretStore };

const SEALED = ".sealed";
const KEY_CHECK = "key-check";

/** The key does not match this brain's key check, or sealed files exist without one. */
export class WrongBrainKey extends Error {
  constructor() {
    super("The key does not open this brain's secrets.");
  }
}

const missingAsNull = (error: NodeJS.ErrnoException): null => {
  if (error.code === "ENOENT") return null;
  throw error;
};

/** Replaces `name` in `dir` so that a crash leaves the old bytes or the new ones, never a mix, and the swap survives power loss. */
async function writeAtomically(dir: string, name: string, bytes: Uint8Array): Promise<void> {
  const temporary = path.join(dir, `${name}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path.join(dir, name));
    const folder = await open(dir, "r");
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * The core's secret stores on the brain: one file per channel, `<channel>.sealed`, sealed under the brain key with the
 * channel's own key (sealed-file.ts). A file that does not open makes `load` throw: a null would let the core make a
 * fresh secret and save it over the old one, as phone access would its key pair, unpairing every phone.
 */
export class SealedSecrets {
  private readonly queues = new Map<string, Promise<unknown>>();

  private constructor(
    private readonly dir: string,
    private readonly key: BrainKey,
  ) {}

  /** Throws WrongBrainKey before anything is opened when the key is not this brain's. The first start records its check. */
  static async open(dir: string, key: BrainKey): Promise<SealedSecrets> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const check = await readFile(path.join(dir, KEY_CHECK)).catch(missingAsNull);
    if (check) {
      if (!keyCheckMatches(key, check)) throw new WrongBrainKey();
    } else {
      // Sealed files without a check were sealed under some key; recording this one beside them could seal over them.
      if ((await readdir(dir)).some((name) => name.endsWith(SEALED))) throw new WrongBrainKey();
      await writeAtomically(dir, KEY_CHECK, brainKeyCheck(key));
    }
    return new SealedSecrets(dir, key);
  }

  store(channel: string): ProtectedSecretStore {
    const name = `${channel}${SEALED}`;
    return {
      load: () =>
        this.serialize(channel, async () => {
          const sealed = await readFile(path.join(this.dir, name)).catch(missingAsNull);
          return sealed && openSecret(this.key, channel, sealed).toString("utf8");
        }),
      save: (value) => this.serialize(channel, () => writeAtomically(this.dir, name, sealSecret(this.key, channel, Buffer.from(value, "utf8")))),
    };
  }

  /** The core's options for every channel in the table; rows the brain keeps none for are left out. */
  stores(): Sealed {
    const entries = Object.entries(BRAIN_SECRETS).flatMap(([option, channel]) => (channel ? [[option, this.store(channel)] as const] : []));
    return Object.fromEntries(entries) as Sealed;
  }

  /** One load or save at a time per channel, in the order asked. */
  private serialize<T>(channel: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(channel) ?? Promise.resolve()).then(operation, operation);
    this.queues.set(
      channel,
      next.catch(() => undefined),
    );
    return next;
  }
}
