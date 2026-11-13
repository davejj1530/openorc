import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AllowanceWindow, PlanLimits } from "@openorc/protocol";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const NOW = Date.now();
const limit = (id: string, label: string, used: number, resetsInMinutes: number): AllowanceWindow => ({
  id,
  label,
  usedPercent: used,
  remainingPercent: 100 - used,
  resetsAt: NOW + resetsInMinutes * 60_000,
  observedAt: NOW,
  exhausted: false,
});
const accounts: PlanLimits[] = [
  {
    id: "codex",
    provider: "codex",
    name: "Codex",
    plan: "Pro",
    status: "available",
    refreshedAt: NOW,
    windows: [limit("codex:primary", "5-hour window", 18, 144), limit("codex:secondary", "7-day window", 36, 4000)],
  },
  {
    id: "claude:work",
    provider: "claude",
    name: "Claude · Work",
    plan: "Team",
    status: "available",
    refreshedAt: NOW,
    windows: [limit("five_hour", "5-hour window", 96, 21), limit("seven_day_opus", "7-day window · Opus", 90, 3000), limit("seven_day", "7-day window", 41, 3000)],
  },
  { id: "claude:client", provider: "claude", name: "Claude · Client", plan: null, status: "disconnected", refreshedAt: null, windows: [] },
];
const antigravity: PlanLimits = {
  id: "antigravity",
  provider: "antigravity",
  name: "Antigravity",
  plan: null,
  status: "available",
  refreshedAt: NOW,
  windows: [
    { ...limit("3p-weekly", "Weekly Limit · Claude and GPT models", 90, 3000), group: "Claude and GPT models" },
    { ...limit("gemini-weekly", "Weekly Limit · Gemini Models", 3, 4000), group: "Gemini Models" },
  ],
};

const claudeThread = { id: "notes", agent: "claude", claudeAccountId: "work", teamInstanceId: null };
let thread: { id: string; agent: string; claudeAccountId: string | null; teamInstanceId: null; model?: string } = claudeThread;
let fx: PlanLimits = { id: "fx", provider: "fx", name: "fx", plan: null, status: "available", refreshedAt: NOW, windows: [], credits: [] };
let fxInstalled = false;
const fxReads: (string | undefined)[] = [];
const usage = (costUsd: number) => ({ inputTokens: 10, outputTokens: 5, costUsd });
const runs = [
  { id: "r1", externalSessionId: "ses_1", usage: usage(0.4) },
  { id: "r2", externalSessionId: "ses_1", usage: usage(1.9698) },
];

vi.mock("../lib/client", async (original) => {
  const read = (method: string, params: { provider?: string; claudeAccountId?: string; fxModel?: string }, options?: { enabled?: boolean }) => {
    if (options?.enabled === false) return { data: undefined };
    if (method === "threads.get") return { data: thread };
    if (method === "claude.accounts.list")
      return {
        data: {
          defaultId: "work",
          accounts: [
            { id: "work", name: "Work", enabled: true },
            { id: "client", name: "Client", enabled: true },
          ],
        },
      };
    if (method === "agents.availability")
      return { data: ["codex", "claude", ...(thread.agent === "antigravity" ? ["antigravity"] : []), ...(fxInstalled ? ["fx"] : [])].map((id) => ({ id, state: "ready" })) };
    if (method === "providers.usage") {
      if (params.provider === "fx") {
        fxReads.push(params.fxModel);
        return { data: { ...fx, context: params.fxModel?.startsWith("codex/") ? "Codex subscription via fx" : "Vercel AI Gateway" } };
      }
      if (params.provider === "opencode") return { data: { windows: [] } };
      if (params.provider === "antigravity") return { data: antigravity };
      return { data: params.provider === "codex" ? accounts[0] : accounts.find((account) => account.id === `claude:${params.claudeAccountId}`) };
    }
    if (method === "runs.listForThread") return { data: runs };
    return { data: undefined };
  };
  return { ...(await original<object>()), useRpc: read, useRpcs: (method: string, params: { provider?: string; claudeAccountId?: string }[]) => params.map((input) => read(method, input)) };
});
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));

import { publishComposerAccount, useComposerAccount } from "../lib/composer-account";
import { useRouter } from "../lib/router";
import { AccountUsage } from "./AccountUsage";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  useComposerAccount.setState({ chosen: null });
  thread = claudeThread;
  fxReads.length = 0;
  fxInstalled = false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("opens every account's 5-hour and weekly limits from the rail's usage bars, the thread's account first", async () => {
  useRouter.setState({ route: { view: "thread", threadId: "notes" } });
  render(<AccountUsage />);
  const button = screen.getByRole("button", { name: "Claude · Work: 59% left this week" });
  // 59% left lights three of the four bars.
  expect(button.querySelector(".account-usage-bars-fill")?.getAttribute("data-icon")).toBe("SignalHigh");
  fireEvent.click(button);
  const table = await screen.findByRole("table");
  const rows = within(table).getAllByRole("row").slice(1);
  expect(rows.map((row) => within(row).getByRole("rowheader").textContent)).toEqual(["Claude · WorkTeam", "CodexPro", "Claude · Client"]);
  expect(rows[0]!.getAttribute("aria-current")).toBe("true");
  expect(
    rows.map((row) =>
      within(row)
        .queryAllByRole("cell")
        .map((cell) => cell.querySelector(".usage-table-value")?.textContent ?? cell.textContent),
    ),
  ).toEqual([["4% left", "59% left"], ["82% left", "64% left"], ["Not signed in"]]);
  expect(rows[0]!.querySelector('[data-tone="low"]')?.textContent).toContain("in 21m");
  // Claude Code prices turns even on a plan, so a Claude conversation never shows a cost.
  expect(screen.queryByRole("region", { name: "This conversation" })).toBeNull();
});

it("on an OpenCode thread, which has no weekly limit, shows the usage bars plain and opens with what the conversation has cost", async () => {
  thread = { id: "notes", agent: "opencode", claudeAccountId: null, teamInstanceId: null };
  useRouter.setState({ route: { view: "thread", threadId: "notes" } });
  render(<AccountUsage />);
  const button = screen.getByRole("button", { name: "OpenCode: no weekly limit" });
  // The rail shows no figure and measures nothing until the popup opens.
  expect(button.textContent).toBe("");
  expect(button.querySelector(".account-usage-bars")).toBeNull();
  expect(button.querySelector("svg")?.getAttribute("data-icon")).toBe("Signal");
  fireEvent.click(button);
  const cost = await screen.findByRole("region", { name: "This conversation" });
  expect(within(cost).getByText("$1.97")).toBeTruthy();
  expect(within(cost).getByText("As OpenCode reports it after each turn.")).toBeTruthy();
  expect(within(screen.getByRole("table")).getAllByRole("row").slice(1)).toHaveLength(3);
});

it("measures Gemini for Antigravity and shows both model pools without implying a missing five-hour quota", async () => {
  thread = { id: "notes", agent: "antigravity", claudeAccountId: null, teamInstanceId: null };
  useRouter.setState({ route: { view: "thread", threadId: "notes" } });
  render(<AccountUsage />);
  fireEvent.click(screen.getByRole("button", { name: "Antigravity: 97% left this week" }));
  const table = await screen.findByRole("table");
  const gemini = within(table).getByRole("row", { name: /Antigravity Gemini Models/ });
  const other = within(table).getByRole("row", { name: /Antigravity Claude and GPT models/ });
  expect(within(gemini).getByText("97% left")).toBeTruthy();
  expect(within(gemini).getByText("Not reported")).toBeTruthy();
  expect(within(other).getByText("10% left")).toBeTruthy();
});

it("off a thread, an agent with no weekly limit shows nothing, since there is no conversation to price", () => {
  useRouter.setState({ route: { view: "newthread" } });
  act(() => publishComposerAccount({ agent: "opencode" }));
  const { container } = render(<AccountUsage />);
  expect(container.innerHTML).toBe("");
});

it("off a thread, reports on the agent and account the new-thread composer has chosen", () => {
  useRouter.setState({ route: { view: "newthread" } });
  act(() => publishComposerAccount({ agent: "codex" }));
  render(<AccountUsage />);
  expect(screen.getByRole("button", { name: "Codex: 64% left this week" })).toBeTruthy();
  act(() => publishComposerAccount({ agent: "claude", claudeAccountId: "work" }));
  expect(screen.getByRole("button", { name: "Claude · Work: 59% left this week" })).toBeTruthy();
});

it("shows an fx balance before a first turn, without a percentage meter or invented weekly limit", async () => {
  fxInstalled = true;
  fx = { ...fx, windows: [], credits: [{ label: "AI Gateway balance", balance: "12.50", unlimited: false, currency: "USD" }] };
  useRouter.setState({ route: { view: "newthread" } });
  publishComposerAccount({ agent: "fx", model: "gateway/anthropic/example" });
  render(<AccountUsage />);
  const button = screen.getByRole("button", { name: "fx: AI Gateway balance: $12.50" });
  expect(button.querySelector(".account-usage-bars")).toBeNull();
  fireEvent.click(button);
  const details = await screen.findByRole("region", { name: "fx account usage" });
  expect(within(details).getByText("$12.50")).toBeTruthy();
  expect(within(details).queryByText("No limits reported")).toBeNull();
  expect(screen.queryByRole("region", { name: "This conversation" })).toBeNull();
  expect(fxReads.every((provider) => provider === "gateway/anthropic/example")).toBe(true);
});

it("labels fx budgets by their actual period and switches the usage connection with the composer model", async () => {
  fxInstalled = true;
  fx = { ...fx, windows: [limit("gateway:budget", "Monthly budget", 25, 10000)], credits: [] };
  useRouter.setState({ route: { view: "newthread" } });
  publishComposerAccount({ agent: "fx", model: "gateway/example" });
  render(<AccountUsage />);
  fireEvent.click(screen.getByRole("button", { name: "fx: 75% left · Monthly budget" }));
  const details = await screen.findByRole("region", { name: "fx account usage" });
  expect(within(details).getByText("Monthly budget")).toBeTruthy();
  expect(within(details).getByText("75% left")).toBeTruthy();
  await act(async () => publishComposerAccount({ agent: "fx", model: "codex/example" }));
  expect(fxReads.at(-1)).toBe("codex/example");
  expect(within(screen.getByRole("region", { name: "fx account usage" })).getByText("Codex subscription via fx")).toBeTruthy();
});

it("reads an fx thread's connection instead of the saved CLI default", () => {
  fxInstalled = true;
  fx = { ...fx, windows: [limit("codex:primary", "Codex · 5-hour window", 20, 100)], credits: [] };
  thread = { id: "notes", agent: "fx", model: "codex/example", claudeAccountId: null, teamInstanceId: null };
  useRouter.setState({ route: { view: "thread", threadId: "notes" } });
  render(<AccountUsage />);
  expect(screen.getByRole("button", { name: "fx: 80% left · Codex · 5-hour window" })).toBeTruthy();
  expect(fxReads).toEqual(["codex/example"]);
});
