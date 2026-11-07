// @vitest-environment jsdom
import type { SubmitRequest } from "@openorc/client";
import type { ClaudeAccountConnection, PlanLimits, RpcMethod, ThreadSession, ThreadSummary } from "@openorc/protocol";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { felt } from "../test-fixtures/haptics";
import { SessionRecovery } from "./SessionRecovery";

const mac = vi.hoisted(() => ({
  phone: null as FakeMac | null,
  accounts: [] as ClaudeAccountConnection[],
  limits: [] as PlanLimits[],
  starts: [] as Record<string, unknown>[],
  refuse: null as string | null,
  calls: [] as string[],
  projects: [] as unknown[],
}));

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method: RpcMethod, params) => {
    mac.calls.push(method);
    if (method === "claude.accounts.list") return Promise.resolve({ accounts: mac.accounts, defaultId: "claude-cli" });
    if (method === "providers.limits") return Promise.resolve(mac.limits);
    if (method === "projects.list") return Promise.resolve(mac.projects);
    if (method !== "runs.start") return Promise.reject(new Error(`no ${method}`));
    if (mac.refuse) return Promise.reject(new Error(mac.refuse));
    mac.starts.push(params as Record<string, unknown>);
    return Promise.resolve({ id: "run-2" });
  });
  return mac.phone.module;
});

const now = Date.UTC(2026, 10, 6, 21, 40);
const account = (id: string, name: string, status: ClaudeAccountConnection["status"] = "ready"): ClaudeAccountConnection => ({
  id,
  name,
  kind: "managed",
  enabled: true,
  createdAt: 1,
  status,
  email: null,
  organization: null,
  message: null,
});
const share = (id: string, remainingPercent: number, over: Partial<PlanLimits["windows"][number]> = {}): PlanLimits => ({
  id: `claude:${id}`,
  provider: "claude",
  name: id,
  plan: "Max",
  status: "available",
  windows: [{ id: "five", label: "5-hour window", usedPercent: 100 - remainingPercent, remainingPercent, resetsAt: now + 2 * 3_600_000, observedAt: now, exhausted: remainingPercent === 0, ...over }],
  refreshedAt: now,
});

const limited: ThreadSession = { status: "error", message: "You've hit your 5-hour limit · resets 4:20pm (Asia/Manila)", recovery: { kind: "usage", provider: "claude" } };
const thread = (session: ThreadSession, over: Partial<ThreadSummary> = {}) => ({ id: "t1", agent: "claude", orclingId: null, claudeAccountId: "secondary", session, ...over }) as ThreadSummary;
const request: Omit<SubmitRequest, "now"> = {
  target: { kind: "thread", threadId: "t1" },
  working: false,
  live: false,
  activeRun: undefined,
  agentsUsed: ["claude"],
  choice: { agent: "claude", model: "opus", effort: null },
  mode: "act",
  permission: "trusted",
  permissionReady: true,
  compacting: false,
  waitForSave: () => Promise.resolve(),
};

function show(
  session: ThreadSession,
  { disabled = false, sent = () => undefined, over = {}, ask = request }: { disabled?: boolean; sent?: () => void; over?: Partial<ThreadSummary>; ask?: typeof request } = {},
) {
  return render(<SessionRecovery thread={thread(session, over)} request={ask} disabled={disabled} onSent={sent} />, { wrapper: mac.phone!.wrapper });
}

const offered = () => screen.getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
  mac.phone!.module.queryClient.clear();
  mac.accounts = [account("secondary", "Q6 secondary"), account("main", "q6 main"), account("rainy", "Rainy")];
  mac.limits = [];
  mac.starts = [];
  mac.refuse = null;
  mac.calls = [];
  mac.projects = [];
  felt.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("names the account that hit its limit and offers the others, the most left first", async () => {
  mac.limits = [share("main", 12), share("rainy", 62), share("secondary", 0)];
  show(limited);
  await waitFor(() => expect(offered()).toEqual(["Continue with Rainy, 62% left", "Continue with q6 main, 12% left"]));
  expect(screen.getByRole("header").textContent).toBe("Q6 secondary reached its limit");
  expect(screen.getByText(limited.message!)).toBeTruthy();
});

it("goes on with the chosen account, resuming the conversation there", async () => {
  mac.limits = [share("rainy", 62)];
  const sent = vi.fn();
  show(limited, { sent });
  const choice = await screen.findByRole("button", { name: /Continue with Rainy/ });
  await act(async () => choice.click());
  expect(mac.starts).toEqual([expect.objectContaining({ threadId: "t1", claudeAccountId: "rainy", resume: true, prompt: "Continue where you left off.", agent: "claude", model: "opus" })]);
  expect(sent).toHaveBeenCalledTimes(1);
  expect(felt).toContain("success");
});

it("rules out an account a current report says is at its limit, and says when it resets", async () => {
  mac.limits = [share("main", 0), share("rainy", 30)];
  show(limited);
  const atLimit = await screen.findByRole("button", { name: /Continue with q6 main, Resets in 2h/ });
  expect(atLimit.getAttribute("aria-disabled") === "true" || (atLimit as HTMLButtonElement).disabled).toBe(true);
  await act(async () => atLimit.click());
  expect(mac.starts).toEqual([]);
  expect(offered()[0]).toContain("Rainy");
});

it("does not hold a stale report against an account", async () => {
  mac.limits = [share("main", 0, { observedAt: now - 3_600_000 })];
  show(limited);
  const choice = await screen.findByRole("button", { name: "Continue with q6 main" });
  await act(async () => choice.click());
  expect(mac.starts).toHaveLength(1);
});

it("offers the accounts before usage answers, so a slow read holds nothing up", async () => {
  mac.limits = [];
  show(limited);
  expect(await screen.findByRole("button", { name: "Continue with q6 main" })).toBeTruthy();
});

it("says why a start failed and lets the person choose again", async () => {
  mac.refuse = "Claude isn't signed in for that account.";
  show(limited);
  const choice = await screen.findByRole("button", { name: "Continue with q6 main" });
  await act(async () => choice.click());
  expect(screen.getByRole("alert").textContent).toBe(mac.refuse);
  expect(felt).toContain("error");
  mac.refuse = null;
  await act(async () => screen.getByRole("button", { name: "Continue with q6 main" }).click());
  expect(mac.starts).toHaveLength(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("holds still while the phone cannot send", async () => {
  show(limited, { disabled: true });
  const choice = await screen.findByRole("button", { name: "Continue with q6 main" });
  await act(async () => choice.click());
  expect(mac.starts).toEqual([]);
});

it("stops at the reset time with one account, and offers no fresh start that would hit the same limit", async () => {
  mac.accounts = [account("secondary", "Q6 secondary")];
  show(limited);
  await waitFor(() => expect(mac.calls).toContain("claude.accounts.list"));
  expect(screen.getByText(limited.message!)).toBeTruthy();
  expect(screen.queryAllByRole("button")).toEqual([]);
});

it("offers no Claude account while the composer is set to another agent", async () => {
  show(limited, { ask: { ...request, choice: { agent: "codex", model: "gpt", effort: null } } });
  await waitFor(() => expect(mac.calls).toContain("claude.accounts.list"));
  expect(screen.queryAllByRole("button")).toEqual([]);
  expect(mac.calls).not.toContain("providers.limits");
});

it("sends a signed-out account's thread on to another, and says where to sign back in", async () => {
  show({ status: "error", message: "Not logged in", recovery: { kind: "sign_in", provider: "claude" } });
  expect(await screen.findByRole("button", { name: "Continue with q6 main" })).toBeTruthy();
  expect(screen.getByRole("header").textContent).toBe("Q6 secondary is signed out");
  expect(screen.getByText("Sign in again on your Mac.")).toBeTruthy();
});

it("words Codex's limit the same, with no accounts to offer", async () => {
  show(
    { status: "error", message: "Usage limit exceeded", recovery: { kind: "usage", provider: "codex" } },
    { over: { agent: "codex" }, ask: { ...request, choice: { agent: "codex", model: "gpt", effort: null } } },
  );
  expect(screen.getByRole("header").textContent).toBe("Codex reached its limit");
  expect(screen.queryAllByRole("button")).toEqual([]);
  expect(mac.calls).toEqual([]);
});

it("restarts a lost session or a failed turn with a fresh one, as on the Mac", async () => {
  const lost = show({ status: "lost", message: null });
  expect(screen.getByRole("header").textContent).toBe("Claude no longer has this session");
  await act(async () => screen.getByRole("button", { name: "Start a fresh session with a handoff" }).click());
  expect(mac.starts[0]).toMatchObject({ resume: false, prompt: "Continue where you left off. Check the working tree first." });
  expect(mac.starts[0]).not.toHaveProperty("claudeAccountId");
  lost.unmount();

  show({ status: "error", message: "boom" });
  expect(screen.getByRole("header").textContent).toBe("The last turn failed");
  expect(screen.getByRole("button", { name: "Retry with a fresh session" })).toBeTruthy();
});

it("draws nothing and asks nothing while the session is well", () => {
  for (const session of [
    { status: "live", message: null },
    { status: "idle", message: null },
  ] as ThreadSession[]) {
    const { container, unmount } = show(session);
    expect(container.textContent).toBe("");
    unmount();
  }
  expect(mac.calls).toEqual([]);
});

it("offers only the accounts the thread's project uses, when it uses only some", async () => {
  mac.projects = [{ id: "p1", name: "block8", settings: { claudeAccounts: { only: true, accountIds: ["secondary", "rainy"], defaultId: "rainy", autoSwitch: false } } }];
  show(limited, { over: { projectId: "p1" } });
  await waitFor(() => expect(offered()).toEqual(["Continue with Rainy"]));
});
