import { BrainMachine, brainKeyFrom, brainKeyText, newBrainKey, sealHandover, type BrainAccess, type BrainMachineStatus, type HandoverClaudeAccount } from "@openorc/cloud";
import { claudeAccounts, redact, type Db } from "@openorc/db";
import type { BrainRegion, CloudBrainMachine, CloudBrainPairing, CloudBrainStatus, CloudBrainStep } from "@openorc/protocol";
import type { ClaudeCloudTokens } from "./claude-cloud-tokens.js";
import type { ProtectedSecretStore } from "./extraction-credentials.js";

/** What phones show for the brain. */
const BRAIN_NAME = "Cloud";
const storageError = "Cannot access protected storage for the cloud brain. Unlock your OS keychain and retry.";
const unavailable = "The cloud brain isn't available in this build.";

/** A brain this build can install. Read only when setting one up, since it is tens of megabytes. */
export interface BrainBundleSource {
  version: string;
  read(): Promise<Buffer>;
}

/** The parts of BrainMachine this uses; tests pass a stand-in. */
export type BrainMachineLike = Pick<BrainMachine, "status" | "provision" | "wake" | "control" | "remove">;

/** The brain's machine on a team. Its project is made only when `create`; otherwise a team without one has none. */
export type OpenBrainMachine = (access: BrainAccess, create: boolean) => Promise<BrainMachineLike | null>;
const openMachine: OpenBrainMachine = (access, create) => (create ? BrainMachine.connect(access) : BrainMachine.find(access));

/** What the brain last took of one Claude account, to name it in Settings and to tell a change since. */
interface Sent {
  id: string;
  name: string;
  default: boolean;
  /** When the token sent was made or pasted. */
  tokenAt: number;
}

/** Kept in protected storage. The key alone opens the brain's secrets, so it is saved before anything is made. */
interface Stored {
  key: string;
  teamId: string;
  region: BrainRegion;
  /** The brain's public host, once it has started. */
  address: string | null;
  /** The brain has started once; until then setting up again keeps this key and region. */
  ready: boolean;
  claude: Sent[];
}

type Activity = { kind: "setting-up"; step: CloudBrainStep } | { kind: "removing" } | { kind: "waking" } | { kind: "sending" };

const MACHINE: Record<BrainMachineStatus["state"], CloudBrainMachine | "missing"> = {
  running: "awake",
  stopped: "asleep",
  starting: "starting",
  stopping: "stopping",
  failed: "failed",
  missing: "missing",
};

const sameSent = (a: Sent[], b: Sent[]) => JSON.stringify(a) === JSON.stringify(b);

export interface CloudBrainDeps {
  db: Db;
  store: ProtectedSecretStore | undefined;
  tokens: Pick<ClaudeCloudTokens, "status" | "token">;
  /** The Vercel connection the brain is made with. The brain keeps its own project on the team. */
  vercel: () => Promise<{ token: string; teamId: string; vcpus?: number } | null>;
  bundle: (() => Promise<BrainBundleSource | null>) | undefined;
  changed: () => void;
  open?: OpenBrainMachine;
}

/**
 * The cloud brain as this Mac sets it up and hands it sign-ins: its key, team, region and what it was last sent, in
 * protected storage; the machine itself through BrainMachine. One operation runs at a time; the status answers
 * between them and never wakes the brain.
 */
export class CloudBrain {
  private pending: Promise<unknown> = Promise.resolve();
  /** Undefined until read; null when no brain is set up. */
  private cache: Stored | null | undefined;
  private activity: Activity | null = null;
  private error: string | null = null;
  /** The team a brain this Mac has no key for was found in, when setting up. */
  private elsewhere: string | null = null;
  private connected: { key: string; machine: BrainMachineLike } | null = null;

  constructor(private readonly deps: CloudBrainDeps) {}

  async status(): Promise<CloudBrainStatus> {
    if (this.activity?.kind === "removing") return { state: "removing" };
    let stored: Stored | null;
    try {
      stored = await this.read();
    } catch (error) {
      return { state: "none", error: words(error) };
    }
    if (!stored) {
      if (await this.stillElsewhere()) return { state: "elsewhere", error: this.error };
      return (await this.deps.bundle?.()) ? { state: "none", error: this.error } : { state: "unavailable" };
    }
    if (this.activity?.kind === "setting-up") return { state: "setting-up", region: stored.region, step: this.activity.step };
    if (!stored.ready) return { state: "incomplete", region: stored.region, error: this.error };
    const { machine, error } = await this.look(stored);
    if (machine === "missing") return { state: "incomplete", region: stored.region, error: this.error ?? "The cloud brain's machine is gone." };
    const working = this.activity?.kind === "waking" || this.activity?.kind === "sending" ? this.activity.kind : null;
    const behind = !sameSent((await this.claude().catch(() => [])).map(sent), stored.claude);
    return { state: "ready", region: stored.region, machine, claude: stored.claude.map((account) => account.name), behind, working, error: this.error ?? error };
  }

  /**
   * Makes the brain in the region and sets it up in the background, its progress in the status. Again after a failure,
   * or on a brain that is set up, it keeps the key and region it has and installs this build's brain.
   */
  async create(region: BrainRegion): Promise<void> {
    const source = await this.serialize(() => this.prepare(region)).catch(async (error: unknown) => {
      throw new Error(await this.scrub(error));
    });
    if (source) void this.run({ kind: "setting-up", step: "machine" }, () => this.setUp(source)).catch(() => undefined);
  }

  /** Starts the brain unless it runs, and sends Claude sign-ins that changed. A failure shows in the status. */
  async wake(): Promise<void> {
    await this.run({ kind: "waking" }, async () => {
      const machine = await this.machine();
      await this.wakeUp(machine);
      if (await this.behind()) await this.send(machine);
    }).catch(() => undefined);
  }

  /** Wakes the brain and asks it for a phone pairing code. A failure shows in the status too, since it can end setup. */
  pair(): Promise<CloudBrainPairing> {
    return this.run({ kind: "waking" }, async () => {
      const machine = await this.machine();
      await this.wakeUp(machine);
      const { url, expiresAt } = await machine.control({ op: "pair" });
      return { url, expiresAt };
    });
  }

  /** Sends the Claude sign-ins, waking the brain. A failure shows in the status. */
  async handover(): Promise<void> {
    await this.run({ kind: "sending" }, async () => {
      const machine = await this.machine();
      await this.wakeUp(machine);
      await this.send(machine);
    }).catch(() => undefined);
  }

  /** A Claude cloud token was saved or removed on this Mac: a brain that is set up takes the new list, woken for it. */
  claudeChanged(): void {
    void this.serialize(async () => {
      if (!(await this.read())?.ready || !(await this.behind())) return;
      await this.tracked({ kind: "sending" }, async () => {
        const machine = await this.machine();
        await this.wakeUp(machine);
        await this.send(machine);
      });
    }).catch(() => undefined);
  }

  /** Deletes the brain, its disk and its thread sandboxes, then forgets its key. A failure shows in the status. */
  async remove(): Promise<void> {
    await this.run({ kind: "removing" }, async () => {
      const stored = await this.read();
      const vercel = await this.vercel();
      await (await this.open({ token: vercel.token, teamId: stored?.teamId ?? vercel.teamId }, false))?.remove();
      await this.write(null);
      this.elsewhere = null;
    }).catch(() => undefined);
  }

  /** The checks a Set up click hears at once. Null when there is nothing to set up in the background. */
  private async prepare(region: BrainRegion) {
    if (this.activity?.kind === "setting-up") return null;
    const source = await this.deps.bundle?.();
    if (!source) throw new Error(unavailable);
    const vercel = await this.vercel();
    if (!(await this.read())) {
      const machine = await this.open({ token: vercel.token, teamId: vercel.teamId }, false);
      if (machine && (await machine.status()).state !== "missing") {
        this.elsewhere = vercel.teamId;
        this.changed();
        return null;
      }
      // Saved before anything is made, so whatever setup leaves behind opens with a key this Mac keeps.
      await this.write({ key: brainKeyText(newBrainKey()), teamId: vercel.teamId, region, address: null, ready: false, claude: [] });
    }
    this.elsewhere = null;
    this.activity = { kind: "setting-up", step: "machine" };
    this.changed();
    return source;
  }

  private async setUp(source: BrainBundleSource): Promise<void> {
    const machine = await this.machine(true);
    await machine.provision({ version: source.version, archive: await source.read() }, { region: (await this.stored()).region });
    this.step("start");
    await this.wakeUp(machine);
    this.step("sign-ins");
    await this.send(machine);
  }

  private step(step: CloudBrainStep): void {
    this.activity = { kind: "setting-up", step };
    this.changed();
  }

  private async wakeUp(machine: BrainMachineLike): Promise<void> {
    const stored = await this.stored();
    const vcpus = (await this.deps.vercel())?.vcpus;
    const result = await machine.wake({ key: brainKeyFrom(stored.key), name: BRAIN_NAME, ...(vcpus ? { threadVcpus: vcpus } : {}) });
    switch (result.state) {
      case "ready":
        if (!stored.ready || stored.address !== result.address) await this.write({ ...stored, ready: true, address: result.address });
        return;
      case "needs-provision":
        await this.write({ ...stored, ready: false });
        throw new Error(`The cloud brain needs setting up again. ${result.detail}`);
      case "wrong-key":
        throw new Error("This Mac's key does not open the cloud brain. Remove it to set up a new one.");
      case "failed":
        throw new Error(`The cloud brain did not start. ${result.detail}`);
    }
  }

  /**
   * Hands over every Claude account with a cloud token, so the brain drops any other. Codex is not sent: a ChatGPT
   * login's refresh token works once, so the Mac's cloud login and a copy on the brain would sign each other out.
   */
  private async send(machine: BrainMachineLike): Promise<void> {
    const stored = await this.stored();
    const accounts = await this.claude();
    const handed: HandoverClaudeAccount[] = accounts.map(({ id, name, default: isDefault, token }) => ({ id, name, default: isDefault, token }));
    await machine.control(sealHandover(brainKeyFrom(stored.key), { claude: { accounts: handed } }));
    await this.write({ ...(await this.stored()), claude: accounts.map(sent) });
  }

  private async behind(): Promise<boolean> {
    const stored = await this.read();
    return stored !== null && !sameSent((await this.claude()).map(sent), stored.claude);
  }

  /** Every enabled Claude account with a cloud token, the default marked. One turned off here does not run there either. */
  private async claude(): Promise<(Sent & { token: string })[]> {
    const access = await this.deps.tokens.status();
    const defaultId = claudeAccounts.defaultId(this.deps.db);
    const accounts: (Sent & { token: string })[] = [];
    for (const { id, name } of claudeAccounts.list(this.deps.db).filter((account) => account.enabled)) {
      const tokenAt = access[id]?.createdAt;
      const token = tokenAt == null ? null : await this.deps.tokens.token(id);
      if (token && tokenAt != null) accounts.push({ id, name, default: id === defaultId, tokenAt, token });
    }
    return accounts;
  }

  /** How Vercel reports the brain's machine; null with a reason when it cannot be asked. */
  private async look(stored: Stored): Promise<{ machine: CloudBrainMachine | "missing" | null; error: string | null }> {
    try {
      const vercel = await this.vercel();
      const machine = await this.open({ token: vercel.token, teamId: stored.teamId }, false);
      return { machine: machine ? MACHINE[(await machine.status()).state] : "missing", error: null };
    } catch (error) {
      return { machine: null, error: `Could not ask Vercel about the cloud brain. ${await this.scrub(error)}` };
    }
  }

  private async vercel(): Promise<{ token: string; teamId: string; vcpus?: number }> {
    const vercel = await this.deps.vercel();
    if (!vercel) throw new Error("Connect Vercel and choose a team first.");
    return vercel;
  }

  /**
   * The machine of the brain this Mac set up, on the team it was made on. Only setup makes the brain's project: a brain
   * whose project is gone needs setting up again.
   */
  private async machine(create = false): Promise<BrainMachineLike> {
    const stored = await this.stored();
    const machine = await this.open({ token: (await this.vercel()).token, teamId: stored.teamId }, create);
    if (machine) return machine;
    await this.write({ ...stored, ready: false });
    throw new Error("The cloud brain's machine is gone.");
  }

  /** One connection per token and team, since connecting looks up the brain's project. */
  private async open(access: BrainAccess, create: boolean): Promise<BrainMachineLike | null> {
    const key = `${access.teamId}\n${access.token}`;
    if (this.connected?.key === key) return this.connected.machine;
    const machine = await (this.deps.open ?? openMachine)(access, create);
    if (machine) this.connected = { key, machine };
    return machine;
  }

  /** Whether the brain found when setting up is still there, on the team Settings has now. */
  private async stillElsewhere(): Promise<boolean> {
    if (!this.elsewhere) return false;
    try {
      const vercel = await this.deps.vercel();
      const machine = vercel?.teamId === this.elsewhere ? await this.open({ token: vercel.token, teamId: vercel.teamId }, false) : null;
      if (!machine || (await machine.status()).state === "missing") this.elsewhere = null;
    } catch {
      // Vercel could not be asked: what was found stays until it can.
    }
    return this.elsewhere !== null;
  }

  /** One operation at a time, shown in the status while it runs, its failure kept for Settings. */
  private run<T>(activity: Activity, work: () => Promise<T>): Promise<T> {
    return this.serialize(() => this.tracked(activity, work));
  }

  private async tracked<T>(activity: Activity, work: () => Promise<T>): Promise<T> {
    this.activity = activity;
    this.error = null;
    this.changed();
    try {
      return await work();
    } catch (error) {
      this.error = await this.scrub(error);
      throw new Error(this.error);
    } finally {
      this.activity = null;
      this.changed();
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => undefined);
    return next;
  }

  private changed(): void {
    this.deps.changed();
  }

  /** An error's words without the Vercel token or the brain key, whatever passed them on. */
  private async scrub(error: unknown): Promise<string> {
    const secrets = [(await this.deps.vercel().catch(() => null))?.token, this.cache?.key];
    return secrets.reduce<string>((text, secret) => (secret ? text.replaceAll(secret, "[redacted]") : text), redact(words(error)).text);
  }

  private async stored(): Promise<Stored> {
    const stored = await this.read();
    if (!stored) throw new Error("The cloud brain is not set up.");
    return stored;
  }

  private async read(): Promise<Stored | null> {
    if (this.cache !== undefined) return this.cache;
    if (!this.deps.store) return (this.cache = null);
    let raw: string | null;
    try {
      raw = await this.deps.store.load();
    } catch {
      throw new Error(storageError);
    }
    try {
      this.cache = raw ? (JSON.parse(raw) as Stored) : null;
    } catch {
      // JSON.parse's message quotes what it read, which holds the key.
      throw new Error(storageError);
    }
    return this.cache;
  }

  private async write(next: Stored | null): Promise<void> {
    try {
      if (!this.deps.store) throw new Error(storageError);
      await this.deps.store.save(next ? JSON.stringify(next) : "");
    } catch {
      throw new Error(storageError);
    }
    this.cache = next;
  }
}

function sent({ id, name, default: isDefault, tokenAt }: Sent): Sent {
  return { id, name, default: isDefault, tokenAt };
}

function words(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
