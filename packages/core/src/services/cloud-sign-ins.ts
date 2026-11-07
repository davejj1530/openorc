import { claudeAccounts, type Db } from "@openorc/db";
import { OPENCODE_FREE_PROVIDER, openCodeProviderName, signInKey, type CloudBrainSignIns, type CloudSignIn, type CloudSignIns, type CloudSignInTarget, type CodexCloudAccess } from "@openorc/protocol";
import type { ClaudeCloudTokens } from "./claude-cloud-tokens.js";
import type { CloudBrain } from "./cloud-brain.js";
import type { OpenCodeCloudKeys } from "./cloud-opencode.js";
import type { CodexCloudLogin } from "./codex-cloud-login.js";
import type { MacSignIns } from "./mac-agent-keys.js";

export interface CloudSignInsDeps {
  db: Db;
  tokens: Pick<ClaudeCloudTokens, "status" | "create" | "finished">;
  codex: Pick<CodexCloudLogin, "status" | "signIn" | "finished" | "saveApiKey">;
  opencode: Pick<OpenCodeCloudKeys, "providers" | "save">;
  brain: Pick<CloudBrain, "exists" | "moves" | "signIns" | "codexSignIn" | "codexFinished" | "codexApiKey" | "setGitHub" | "handover">;
  mac: MacSignIns;
  changed(): void;
}

/** A row and what brings it; none for one only a typed key makes ready. */
type Row = CloudSignIn & { bring?: () => Promise<void> };
type State = CloudSignIn["state"];

function stateOf(ready: boolean, working: boolean, error: string | null): State {
  if (working) return "working";
  if (ready) return "ready";
  return error ? "failed" : "missing";
}

const words = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * One step that brings every sign-in the cloud can use: a row for each enabled Claude account, Codex for this Mac's
 * sandboxes, each OpenCode provider, and with a cloud brain its own Codex login and this Mac's GitHub. Each row's state
 * comes from the service that keeps it, so running again does only what is still missing. Rows are brought one at a
 * time, so one browser sign-in finishes or is cancelled before the next opens; copies need no browser, and are made
 * only with the person's yes.
 */
export class CloudSignInsFlow {
  private lane: Promise<unknown> = Promise.resolve();
  /** Jobs in the lane, so the status says it is bringing from the moment it is asked. */
  private queued = 0;
  private running = false;
  private cancelled = false;
  /** The row being brought now. */
  private current: string | null = null;
  /** Why a copy failed, by row; browser sign-ins keep their own. */
  private readonly errors = new Map<string, string>();

  constructor(private readonly deps: CloudSignInsDeps) {}

  async status(): Promise<CloudSignIns> {
    const rows = await this.rows(false);
    return { rows: rows.map(({ bring: _bring, ...row }) => row), bringing: this.queued > 0 };
  }

  /** Brings every missing row, copies first, then hands what changed to the cloud brain. Copies only with `copy`. */
  bringAll(copy: boolean): void {
    if (this.running) return;
    this.running = true;
    this.cancelled = false;
    void this.inLane(async () => {
      const tried = new Set<string>();
      let row: Row | undefined;
      while (!this.cancelled && (row = next(await this.rows(true), copy, tried))) {
        tried.add(signInKey(row));
        await this.bringRow(row);
      }
      if (tried.size && (await this.deps.brain.moves())) await this.deps.brain.handover();
    }).finally(() => {
      this.running = false;
    });
  }

  /** Brings one row; asking for a copy is the person's yes to it. */
  bring(target: CloudSignInTarget): void {
    const key = signInKey(target);
    void this.inLane(async () => {
      const row = (await this.rows(true)).find((each) => signInKey(each) === key);
      if (row && waiting(row)) await this.bringRow(row);
    });
  }

  /** Stops after the row under way. */
  cancel(): void {
    this.cancelled = true;
    this.deps.changed();
  }

  private inLane(job: () => Promise<void>): Promise<void> {
    this.queued += 1;
    this.deps.changed();
    const done = this.lane.then(job).catch(() => undefined);
    this.lane = done.finally(() => {
      this.queued -= 1;
      this.deps.changed();
    });
    return done;
  }

  private async bringRow(row: Row): Promise<void> {
    const key = signInKey(row);
    this.current = key;
    this.errors.delete(key);
    this.deps.changed();
    try {
      await row.bring!();
    } catch (error) {
      this.errors.set(key, words(error));
    } finally {
      this.current = null;
      this.deps.changed();
    }
  }

  private async rows(fresh: boolean): Promise<Row[]> {
    const { brain, mac } = this.deps;
    const [codexKey, held] = await Promise.all([mac.codexApiKey(fresh).catch(() => null), brain.exists().then((exists) => (exists ? brain.signIns() : null))]);
    const rows = [...(await this.claude()), ...this.codex(await this.deps.codex.status(), codexKey), ...(held ? this.brainCodex(held.codex, codexKey) : []), ...(await this.openCode(fresh))];
    if (held) rows.push(this.github(held.github));
    return rows.map((row) => this.overlaid(row));
  }

  /** A copy under way or failed here shows on its row. */
  private overlaid(row: Row): Row {
    const key = signInKey(row);
    if (this.current === key) return { ...row, state: "working" };
    const error = row.state === "ready" ? null : (this.errors.get(key) ?? null);
    return error ? { ...row, state: "failed", error } : row;
  }

  /** Every enabled account, the default first: the CLI's own login signs in in the browser, an added one in a private window. */
  private async claude(): Promise<Row[]> {
    const { db, tokens } = this.deps;
    const access = await tokens.status();
    const defaultId = claudeAccounts.defaultId(db);
    const accounts = claudeAccounts.list(db).filter((account) => account.enabled);
    accounts.sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId));
    return accounts.map(({ id, name, kind }) => {
      const each = access[id];
      return {
        kind: "claude",
        accountId: id,
        label: name,
        state: stateOf(each?.createdAt != null, Boolean(each?.creating), each?.error ?? null),
        way: kind === "managed" ? "private-window" : "browser",
        error: each?.error ?? null,
        bring: async () => {
          await tokens.create(id);
          await tokens.finished(id);
        },
      };
    });
  }

  /** The login this Mac's sandboxes use: this Mac's API key copied, or a ChatGPT sign-in of its own. */
  private codex(status: CodexCloudAccess, macKey: string | null): Row[] {
    const { codex, mac } = this.deps;
    if (!mac.codexInstalled() && !status.mode) return [];
    return [
      {
        kind: "codex",
        label: "Codex",
        state: stateOf(status.mode !== null, status.signingIn, status.error),
        way: macKey ? "copy" : "browser",
        error: status.error,
        bring: macKey
          ? () => codex.saveApiKey(macKey)
          : async () => {
              await codex.signIn();
              await codex.finished();
            },
      },
    ];
  }

  /** The brain's own: this Mac's API key copied, or a ChatGPT sign-in made for it alone. One on its way counts as there. */
  private brainCodex(codex: CloudBrainSignIns["codex"], macKey: string | null): Row[] {
    const { brain, mac } = this.deps;
    const ready = codex.mode !== null || (codex.pending !== null && codex.pending !== "sign-out");
    if (!mac.codexInstalled() && !ready && !macKey) return [];
    return [
      {
        kind: "brain-codex",
        label: "Codex on the cloud brain",
        state: stateOf(ready, codex.signingIn, codex.error),
        way: macKey ? "copy" : "browser",
        error: codex.error,
        bring: macKey
          ? async () => brain.codexApiKey(macKey)
          : async () => {
              brain.codexSignIn();
              await brain.codexFinished();
            },
      },
    ];
  }

  /**
   * Each provider with a cloud key or on this Mac's OpenCode. A Mac key may be copied; a provider the Mac signs in to
   * with an account needs a key typed in, as the cloud passes OpenCode a key alone. Its free provider needs none.
   */
  private async openCode(fresh: boolean): Promise<Row[]> {
    const { opencode, mac } = this.deps;
    const [cloud, here] = await Promise.all([opencode.providers(), mac.opencode(fresh).catch(() => [])]);
    const providers = [...new Set([...cloud, ...here.map((each) => each.provider)])].filter((provider) => provider !== OPENCODE_FREE_PROVIDER).sort();
    return providers.map((provider) => {
      const key = here.find((each) => each.provider === provider)?.key ?? null;
      return {
        kind: "opencode",
        provider,
        label: openCodeProviderName(provider),
        state: cloud.includes(provider) ? "ready" : "missing",
        way: key ? "copy" : "key",
        error: null,
        ...(key ? { bring: () => opencode.save(provider, key) } : {}),
      };
    });
  }

  /** This Mac's GitHub sign-in on the brain: switched on, it goes with every handover. */
  private github(github: CloudBrainSignIns["github"]): Row {
    const { brain } = this.deps;
    const blocked = github.on ? null : github.blocked;
    return {
      kind: "github",
      label: "GitHub",
      state: stateOf(github.on, false, blocked),
      way: "copy",
      error: blocked,
      bring: async () => {
        await brain.setGitHub(true);
        const after = (await brain.signIns()).github;
        if (!after.on) throw new Error(after.blocked ?? "GitHub did not reach the cloud brain. Try again.");
      },
    };
  }
}

/** A row that bringing would change: not ready, not under way, and brought by something other than a typed key. */
const waiting = (row: Row) => row.bring !== undefined && row.state !== "ready" && row.state !== "working";

/** The next row to bring in a run: copies first, then each browser sign-in in order, each tried once. */
function next(rows: Row[], copy: boolean, tried: Set<string>): Row | undefined {
  const left = rows.filter((row) => waiting(row) && (copy || row.way !== "copy") && !tried.has(signInKey(row)));
  return left.find((row) => row.way === "copy") ?? left[0];
}
