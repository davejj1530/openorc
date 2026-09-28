import { createHash } from "node:crypto";
import { consumeCodexReset, type CodexAccountReport, type CodexUsageOptions } from "@openorc/agents";
import { settings, type Db } from "@openorc/db";
import type { ResetCredit, ResetInventory, ResetOutcome } from "@openorc/protocol";

const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const attemptKey = (id: string) => `providerUsage.codex.resetAttempt.${id}`;
const pendingKey = (account: string) => `providerUsage.codex.pendingReset.${account}`;

export interface ResetInput {
  attemptId: string;
  creditId?: string;
  confirmationToken: string;
}
interface Attempt {
  id: string;
  account: string;
  creditId?: string;
  outcome?: ResetOutcome;
}
export interface ResetReply {
  outcome: ResetOutcome;
  message: string;
}

const messages: Record<ResetOutcome, string> = {
  reset: "Reset used. Check the refreshed allowance below before continuing.",
  alreadyRedeemed: "This reset was already used by this attempt. Check the refreshed allowance below.",
  nothingToReset: "There is no eligible usage window to reset. The reset has not been used.",
  noCredit: "No reset is currently available. Check your provider usage page.",
  unsupported: "This Codex CLI cannot redeem resets. Update it or open your provider usage page.",
  confirmationRequired: "The account or reset inventory changed. Review the refreshed details and confirm again.",
  pending: "The reset outcome could not be confirmed. Retry this same attempt to check safely; do not start a new reset.",
};

export function codexResetInventory(limits: unknown, now: number): ResetInventory {
  const raw = record(record(limits)["rateLimitResetCredits"]);
  const count = raw["availableCount"];
  const availableCount = typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null;
  const credits: ResetCredit[] | null = Array.isArray(raw["credits"])
    ? raw["credits"].flatMap((v) => {
        const row = record(v);
        const id = text(row["id"]);
        const expires = row["expiresAt"];
        const expiresAt = typeof expires === "number" && Number.isFinite(expires) && expires > 0 && expires * 1000 <= 8.64e15 ? expires * 1000 : null;
        if (!id || row["status"] !== "available" || (expiresAt !== null && expiresAt <= now)) return [];
        return [{ id, title: text(row["title"]), description: text(row["description"]), expiresAt }];
      })
    : null;
  return { availableCount, credits, redemption: availableCount === null ? "external" : "available" };
}

class ConfirmationChanged extends Error {}

/** Durable logical attempts keep a lost response from consuming a second reset. */
export class CodexResetService {
  private active: { id: string; promise: Promise<ResetReply> } | null = null;
  private readonly unsupported = new Set<string>();
  private revision: number | undefined;

  observeRevision(revision: number | undefined): void {
    if (revision !== this.revision) {
      this.unsupported.clear();
      this.revision = revision;
    }
  }
  constructor(
    private readonly db: Db,
    private readonly consume = consumeCodexReset,
    private readonly now = Date.now,
  ) {}

  private identity(report: CodexAccountReport, connection: string): string {
    return hash([connection, report.account]);
  }

  private attempt(id: string): Attempt | null {
    const saved = settings.get(this.db, attemptKey(id));
    if (!saved) return null;
    try {
      const value = JSON.parse(saved) as Attempt;
      return value.id === id && typeof value.account === "string" ? value : null;
    } catch {
      return null;
    }
  }

  describe(report: CodexAccountReport, connection: string): ResetInventory {
    const inventory = codexResetInventory(report.limits, this.now());
    const account = this.identity(report, connection);
    const id = settings.get(this.db, pendingKey(account));
    const pending = id ? this.attempt(id) : null;
    return {
      ...inventory,
      confirmationToken: hash([account, inventory]),
      ...(this.unsupported.has(connection) ? { redemption: "external" as const, message: messages.unsupported } : {}),
      ...(pending && !pending.outcome && pending.account === account ? { pendingAttempt: { id: pending.id, ...(pending.creditId ? { creditId: pending.creditId } : {}) } } : {}),
    };
  }

  redeem(input: ResetInput, options: CodexUsageOptions, connection: string): Promise<ResetReply> {
    if (this.active) return this.active.id === input.attemptId ? this.active.promise : Promise.resolve({ outcome: "pending", message: messages.pending });
    const promise = this.perform(input, options, connection).finally(() => {
      this.active = null;
    });
    this.active = { id: input.attemptId, promise };
    return promise;
  }

  private async perform(input: ResetInput, options: CodexUsageOptions, connection: string): Promise<ResetReply> {
    let attempt = this.attempt(input.attemptId);
    let outcome: ResetOutcome;
    try {
      // Always re-read the current account, including retries. A retry may use a
      // consumed credit ID: the provider's original idempotency key resolves it.
      outcome = await this.consume({ idempotencyKey: input.attemptId, ...(input.creditId ? { creditId: input.creditId } : {}) }, options, (report) => {
        const account = this.identity(report, connection);
        if (record(report.account)["type"] !== "chatgpt") throw new ConfirmationChanged();
        if (attempt) {
          if (attempt.account !== account || attempt.creditId !== input.creditId) throw new ConfirmationChanged();
          if (attempt.outcome) throw new CompletedAttempt(attempt.outcome);
          return;
        }
        const pendingId = settings.get(this.db, pendingKey(account));
        const pending = pendingId ? this.attempt(pendingId) : null;
        if (pending && !pending.outcome && pending.account === account) throw new CompletedAttempt("pending");
        const current = this.describe(report, connection);
        if (current.confirmationToken !== input.confirmationToken || current.redemption !== "available") throw new ConfirmationChanged();
        if (current.availableCount === 0) throw new CompletedAttempt("noCredit");
        if (input.creditId && !current.credits?.some((credit) => credit.id === input.creditId)) throw new ConfirmationChanged();
        attempt = { id: input.attemptId, account, ...(input.creditId ? { creditId: input.creditId } : {}) };
        settings.set(this.db, attemptKey(attempt.id), JSON.stringify(attempt));
        settings.set(this.db, pendingKey(account), attempt.id);
      });
    } catch (error) {
      outcome = failedResetOutcome(error);
    }
    if (outcome === "unsupported") this.unsupported.add(connection);
    if (attempt && outcome !== "pending" && outcome !== "confirmationRequired") {
      settings.set(this.db, attemptKey(attempt.id), JSON.stringify({ ...attempt, outcome }));
      if (settings.get(this.db, pendingKey(attempt.account)) === attempt.id) settings.remove(this.db, pendingKey(attempt.account));
    }
    return { outcome, message: messages[outcome] };
  }
}

class CompletedAttempt extends Error {
  constructor(readonly outcome: ResetOutcome) {
    super(outcome);
  }
}

function failedResetOutcome(error: unknown) {
  if (error instanceof ConfirmationChanged) return "confirmationRequired" as const;
  if (error instanceof CompletedAttempt) return error.outcome;
  return "pending" as const;
}
