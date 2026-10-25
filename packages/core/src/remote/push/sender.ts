import { randomUUID } from "node:crypto";
import { remotePushTargets, type Db, type PushRecipient } from "@openorc/db";
import { collapseId, pushKeys, sealPush, type KeyPair, type PushNotice } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import type { PushEnvironment, PushRefusal, RemotePush, RemoteRpcResults } from "@openorc/protocol";
import type { Logger } from "../../transport.js";
import { fitPayload } from "./payload.js";
import { groupOf, planAlert, QUIET_WINDOW_MS, type AlertGroup, type AlertPlan } from "./plan.js";
import type { PushDelivery, PushOutcome, PushRoute } from "./route.js";

type Notice = Extract<RemotePush, { type: "notify" }>;
type TestResult = RemoteRpcResults["remote.push.test"];
/** What APNs said about one phone's alert, and the host it went to. */
type Sent = { outcome: PushOutcome; environment: PushEnvironment };

/** How long Apple keeps trying a phone that is off. */
const EXPIRES_AFTER_S = 12 * 3600;
/** Asking main whether the Mac is in use may not hold an alert back longer than this; no answer reads as away. */
const PRESENCE_WITHIN_MS = 250;

export interface PushSenderDeps {
  db: Db;
  /** The route for the Mac's push key, or null before one is added. */
  route: () => Promise<PushRoute | null>;
  /** Whether someone is using the Mac right now. */
  presence: () => Promise<boolean>;
  log: Logger;
  /** Something the desktop shows changed: the phones registered, or the sender state through Apple's refusal. */
  changed(what: "phones" | "sender"): void;
  now?: () => number;
}

const noticeOf = (notice: Notice): PushNotice => ({
  id: notice.id ?? randomUUID(),
  kind: notice.kind,
  threadId: notice.threadId,
  title: notice.title,
  body: notice.body,
  ...(notice.kind === "approval" && notice.runId && notice.approvalId ? { approval: { runId: notice.runId, approvalId: notice.approvalId } } : {}),
});

function firstRefusal(outcomes: Sent[]): PushRefusal | null {
  for (const { outcome, environment } of outcomes) if (outcome.kind === "refused") return { reason: outcome.reason, environment };
  return null;
}

async function macInUse(presence: () => Promise<boolean>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const away = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), PRESENCE_WITHIN_MS)));
  try {
    return await Promise.race([presence().catch(() => false), away]);
  } finally {
    clearTimeout(timer);
  }
}

/** Seals each notice for the phones that want it and hands the deliveries to the route, one notice at a time. Never throws into the core. */
export class PushSender {
  private readonly lastRing = new Map<string, { at: number; group: AlertGroup }>();
  /** Apple's refusal of the key on each host: a key can be good for one environment and not the other. */
  private readonly refusals = new Map<PushEnvironment, string>();
  private work: Promise<unknown> = Promise.resolve();
  /** Bumped when phone access stops, so whatever still waits its turn is dropped rather than sent. */
  private epoch = 0;
  private readonly now: () => number;

  constructor(private readonly deps: PushSenderDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Apple's refusal of the key, kept until a send to that environment succeeds or the key changes; the sandbox's first. */
  get problem(): PushRefusal | null {
    for (const environment of ["sandbox", "production"] as const) {
      const reason = this.refusals.get(environment);
      if (reason) return { reason, environment };
    }
    return null;
  }

  /** Whether Apple refuses the key for a phone in this environment. */
  refuses(environment: PushEnvironment): boolean {
    return this.refusals.has(environment);
  }

  /** Resolves once this notice was sent or dropped, after every notice handed over before it. Never rejects. */
  send(notice: Notice, mac: KeyPair): Promise<void> {
    if (!notice.threadId) return Promise.resolve();
    const epoch = this.epoch;
    // queue logs a failure, so nothing is left to handle here.
    return this.queue(() => this.deliver(noticeOf(notice), mac, epoch)).catch(() => undefined);
  }

  /** The desktop's "Send a test": every registered phone, whatever it takes and wherever you are. */
  test(mac: KeyPair, macName: string): Promise<TestResult> {
    const notice: PushNotice = { id: randomUUID(), kind: "test", threadId: null, title: "OpenOrc", body: `Notifications from ${macName} reach this iPhone.` };
    const epoch = this.epoch;
    return this.queue(async () => {
      const route = epoch === this.epoch ? await this.deps.route() : null;
      const outcomes = route ? await this.fanOut(route, notice, mac, false, epoch) : [];
      const count = (kind: PushOutcome["kind"]) => outcomes.filter(({ outcome }) => outcome.kind === kind).length;
      return { sent: count("sent"), failed: count("failed"), problem: firstRefusal(outcomes) };
    });
  }

  /** A refusal of the old key says nothing about the new one. */
  keyChanged(): void {
    this.refusals.clear();
  }

  /** Phone access stopped: nothing still waiting is sent, and an old refusal and recent rings no longer apply. */
  close(): void {
    this.epoch += 1;
    this.refusals.clear();
    this.lastRing.clear();
  }

  private queue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.work.then(task);
    this.work = next.catch((error: unknown) => this.deps.log.warn(`Phone alerts failed: ${error instanceof Error ? error.message : String(error)}`));
    return next;
  }

  private async deliver(notice: PushNotice, mac: KeyPair, epoch: number): Promise<void> {
    if (epoch !== this.epoch) return;
    const route = await this.deps.route();
    if (!route || remotePushTargets.count(this.deps.db) === 0) return;
    await this.fanOut(route, notice, mac, await macInUse(this.deps.presence), epoch);
  }

  /**
   * Plans, seals and sends the notice for each phone in turn, until phone access stops. An earlier phone's send can
   * take a while, so each row is read again just before its alert is sealed: a phone removed or turned off meanwhile
   * gets nothing, and one that registered again gets what it asked for last. A ring counts once APNs took it.
   */
  private async fanOut(route: PushRoute, notice: PushNotice, mac: KeyPair, inUse: boolean, epoch: number): Promise<Sent[]> {
    const now = this.now();
    for (const [key, ring] of this.lastRing) if (now - ring.at >= QUIET_WINDOW_MS) this.lastRing.delete(key);
    const outcomes: Sent[] = [];
    for (const { deviceId } of remotePushTargets.recipients(this.deps.db)) {
      if (epoch !== this.epoch) break;
      const recipient = remotePushTargets.recipient(this.deps.db, deviceId);
      if (!recipient) continue;
      const ringKey = `${recipient.deviceId}\n${notice.threadId}`;
      const plan = planAlert(notice, recipient, { macInUse: inUse, lastRing: this.lastRing.get(ringKey) ?? null, now });
      if (!plan) continue;
      const outcome = await this.sendTo(route, notice, recipient, mac, plan);
      if (!outcome) continue;
      outcomes.push({ outcome, environment: recipient.environment });
      if (outcome.kind === "sent" && plan.kind === "ring" && notice.kind !== "test") this.lastRing.set(ringKey, { at: this.now(), group: groupOf(notice.kind) });
    }
    return outcomes;
  }

  private async sendTo(route: PushRoute, notice: PushNotice, recipient: PushRecipient, mac: KeyPair, plan: AlertPlan): Promise<PushOutcome | null> {
    const delivery = this.delivery(notice, recipient, mac, plan);
    if (!delivery) {
      this.deps.log.warn("A phone alert was too large to send.");
      return null;
    }
    const outcome = await route.send(delivery);
    this.record(outcome, recipient);
    return outcome;
  }

  private delivery(notice: PushNotice, recipient: PushRecipient, mac: KeyPair, plan: AlertPlan): PushDelivery | null {
    const keys = pushKeys(nodeCrypto, mac, recipient.publicKey, "mac");
    const payload = fitPayload(notice, plan, (fitted) => sealPush(nodeCrypto, keys.seal, mac.publicKey, fitted));
    if (!payload) return null;
    const priority = plan.kind === "ring" ? 10 : 5;
    return {
      token: recipient.token,
      environment: recipient.environment,
      collapseId: collapseId(nodeCrypto, keys.collapse, notice.threadId),
      priority,
      expiresAt: Math.floor(this.now() / 1000) + EXPIRES_AFTER_S,
      payload,
    };
  }

  private record(outcome: PushOutcome, recipient: PushRecipient): void {
    const { environment } = recipient;
    switch (outcome.kind) {
      case "sent":
        if (!this.refusals.delete(environment)) return;
        return this.deps.changed("sender");
      case "gone":
        remotePushTargets.removeToken(this.deps.db, recipient.token);
        return this.deps.changed("phones");
      case "refused":
        if (this.refusals.get(environment) === outcome.reason) return;
        this.refusals.set(environment, outcome.reason);
        return this.deps.changed("sender");
      case "failed":
        return this.deps.log.warn(`APNs did not take a phone alert: ${outcome.reason}`);
    }
  }
}
