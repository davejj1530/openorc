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

vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string, params: { provider?: string }) => {
    if (method === "threads.get") return { data: { id: "notes", agent: "claude", claudeAccountId: "work", teamInstanceId: null } };
    if (method === "claude.accounts.list") return { data: { defaultId: "work", accounts: [{ id: "work", name: "Work" }] } };
    if (method === "providers.usage") return { data: { windows: (params.provider === "codex" ? accounts[0]! : accounts[1]!).windows } };
    if (method === "providers.limits") return { data: accounts };
    return { data: undefined };
  },
}));
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
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("opens every account's 5-hour and weekly limits from the chip, the thread's account first", async () => {
  useRouter.setState({ route: { view: "thread", threadId: "notes" } });
  render(<AccountUsage />);
  fireEvent.click(screen.getByRole("button", { name: "Claude · Work: 59% left this week" }));
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
});

it("off a thread, reports on the agent and account the new-thread composer has chosen", () => {
  useRouter.setState({ route: { view: "newthread" } });
  act(() => publishComposerAccount({ agent: "codex" }));
  render(<AccountUsage />);
  expect(screen.getByRole("button", { name: "Codex: 64% left this week" })).toBeTruthy();
  act(() => publishComposerAccount({ agent: "claude", claudeAccountId: "work" }));
  expect(screen.getByRole("button", { name: "Claude · Work: 59% left this week" })).toBeTruthy();
});

it.each([
  [120, "full"],
  [70, "short"],
  [40, "icon"],
])("in a %ipx slot, takes the fullest look that fits: %s", (room, look) => {
  const widths: Record<string, number> = { full: 88, short: 66, icon: 32 };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains("sidebar-usage") ? room : (widths[this.dataset.look ?? "full"] ?? 0);
    return { width, height: 32, top: 0, left: 0, right: width, bottom: 32, x: 0, y: 0, toJSON: () => ({}) };
  });
  useRouter.setState({ route: { view: "thread", threadId: "notes" } });
  render(
    <div className="sidebar-usage">
      <AccountUsage />
    </div>,
  );
  expect((screen.getByRole("button", { name: "Claude · Work: 59% left this week" }) as HTMLElement).dataset.look).toBe(look);
});
