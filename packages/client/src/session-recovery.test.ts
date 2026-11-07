import { DEFAULT_CLAUDE_ACCOUNT, type ClaudeAccountConnection, type ThreadSession } from "@openorc/protocol";
import { expect, it } from "vitest";
import { accountsToContinueWith, canContinueWithAnother } from "./session-recovery.js";

const limited: ThreadSession = { status: "error", message: "You've hit your 5-hour limit · resets 4:20pm", recovery: { kind: "usage", provider: "claude" } };
type Thread = Parameters<typeof accountsToContinueWith>[0];
const thread = (over: Partial<Thread> = {}): Thread => ({ agent: "claude", orclingId: null, session: limited, claudeAccountId: "main", ...over });
const account = (id: string, status: ClaudeAccountConnection["status"] = "ready"): ClaudeAccountConnection => ({
  id,
  name: id,
  kind: "managed",
  enabled: true,
  createdAt: 1,
  status,
  email: null,
  organization: null,
  message: null,
});

it("offers every signed-in account but the thread's own, once a limit stopped it", () => {
  const accounts = [account("main"), account("rainy"), account("spare"), account("out", "signed_out"), account("off", "disabled")];
  expect(accountsToContinueWith(thread(), accounts).map(({ id }) => id)).toEqual(["rainy", "spare"]);
});

it("takes a thread with no account of its own to be on the default one", () => {
  const accounts = [account(DEFAULT_CLAUDE_ACCOUNT), account("rainy")];
  expect(accountsToContinueWith(thread({ claudeAccountId: null }), accounts).map(({ id }) => id)).toEqual(["rainy"]);
});

it("offers them after a signed-out account too, where only the Mac could otherwise help", () => {
  expect(canContinueWithAnother(thread({ session: { ...limited, recovery: { kind: "sign_in", provider: "claude" } } }))).toBe(true);
});

it("offers nothing when another account would not help or the thread is not Claude's", () => {
  const accounts = [account("main"), account("rainy")];
  for (const stopped of [
    thread({ session: { status: "error", message: "boom" } }),
    thread({ session: { status: "lost", message: null } }),
    thread({ session: { status: "live", message: null } }),
    thread({ agent: "codex", session: { ...limited, recovery: { kind: "usage", provider: "codex" } } }),
    thread({ orclingId: "orc" }),
  ]) {
    expect(canContinueWithAnother(stopped)).toBe(false);
    expect(accountsToContinueWith(stopped, accounts)).toEqual([]);
  }
});
