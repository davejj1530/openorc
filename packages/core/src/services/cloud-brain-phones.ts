import { doorEpoch, type BrainPhone } from "@openorc/cloud";
import { settings, type Db } from "@openorc/db";
import type { RemoteDevice } from "@openorc/protocol";
import type { BrainMachineLike } from "./cloud-brain-machine.js";

const KEY = "cloud.brain.phones";
/** A list this old is asked again while Settings shows it; only a list this fresh says a phone is connected. */
export const PHONES_FRESH_MS = 60_000;
/** While a pairing code is out, a new phone shows this soon. */
const PAIRING_MS = 10_000;

interface Kept {
  /** The phones as the brain last said, and when. */
  heard: { phones: BrainPhone[]; at: number } | null;
  /** Each phone this Mac unpaired, and when. */
  unpaired: { id: string; at: number }[];
}

export interface BrainPhonesDeps {
  db: Db;
  /** The setting they are kept under; the cloud brain's own unless given. */
  key?: string | undefined;
  /** `work` on the brain's machine, in turn with the brain's other operations; `wake` starts the brain first. */
  machine<T>(wake: boolean, work: (machine: BrainMachineLike) => Promise<T>): Promise<T>;
  changed(): void;
}

/**
 * The phones paired with the cloud brain as this Mac last heard them, which Settings lists without waking the brain, and
 * their removal, which wakes it. Kept in the ledger's settings: names and device ids, nothing that opens anything.
 */
export class BrainPhones {
  private askedAt = Number.NEGATIVE_INFINITY;
  private pairingUntil = 0;

  constructor(private readonly deps: BrainPhonesDeps) {}

  /** The last list, asked again of a running brain in the background once it is a minute old. Never wakes it. */
  list(now = Date.now()): RemoteDevice[] {
    const { heard } = this.kept();
    const every = now < this.pairingUntil ? PAIRING_MS : PHONES_FRESH_MS;
    if (now - (heard?.at ?? Number.NEGATIVE_INFINITY) >= every && now - this.askedAt >= every) void this.ask(now);
    if (!heard) return [];
    const live = now - heard.at < PHONES_FRESH_MS;
    // A phone connected when the brain answered was last seen then.
    return heard.phones.map((phone) => (phone.connected ? { ...phone, lastSeenAt: heard.at, connected: live } : phone));
  }

  /** A pairing code went out, good until `expiresAt`: the phone that takes it shows within seconds. */
  pairing(expiresAt: number): void {
    this.pairingUntil = expiresAt;
  }

  /** Hears the brain's list. One asleep, or one from before this request, leaves the last list as it is. */
  async ask(now = Date.now()): Promise<void> {
    this.askedAt = now;
    const answer = await this.deps.machine(false, (machine) => machine.control({ op: "phones" })).catch(() => null);
    if (!answer) return;
    this.save({ ...this.kept(), heard: { phones: answer.phones, at: now } });
    this.deps.changed();
  }

  /**
   * Unpairs a phone on the brain, woken for it, so the phone can no longer connect. Recorded before the operation ends,
   * so the door, brought to this record after the wake, refuses its knocks too.
   */
  async remove(id: string): Promise<RemoteDevice[]> {
    await this.deps.machine(true, async (machine) => {
      const { phones } = await machine.control({ op: "remove-phone", id });
      const at = Date.now();
      this.save({ heard: { phones, at }, unpaired: [...this.kept().unpaired.filter((each) => each.id !== id), { id, at }] });
    });
    this.deps.changed();
    return this.list();
  }

  /**
   * The phones the door refuses: those unpaired while a ticket the brain gave them could still hold. A ticket holds in
   * its epoch and the next; one more covers a brain's clock running a little ahead at an epoch's turn.
   */
  refused(now = Date.now()): string[] {
    return this.kept()
      .unpaired.filter(({ at }) => doorEpoch(now) <= doorEpoch(at) + 2)
      .map(({ id }) => id);
  }

  /** The brain is gone, and every phone paired with it with it. */
  forget(): void {
    settings.remove(this.deps.db, this.key);
  }

  private get key(): string {
    return this.deps.key ?? KEY;
  }

  private kept(): Kept {
    try {
      return { heard: null, unpaired: [], ...(JSON.parse(settings.get(this.deps.db, this.key) ?? "{}") as Partial<Kept>) };
    } catch {
      return { heard: null, unpaired: [] };
    }
  }

  private save(kept: Kept): void {
    settings.set(this.deps.db, this.key, JSON.stringify(kept));
  }
}
