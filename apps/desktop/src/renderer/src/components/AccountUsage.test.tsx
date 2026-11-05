import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AllowanceWindow, PlanLimits } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";

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
  useRpc: (method: string) => {
    if (method === "threads.get") return { data: { id: "notes", agent: "claude", claudeAccountId: "work", teamInstanceId: null } };
    if (method === "claude.accounts.list") return { data: { defaultId: "work", accounts: [{ id: "work", name: "Work" }] } };
    if (method === "providers.usage") return { data: { windows: accounts[1]!.windows } };
    if (method === "providers.limits") return { data: accounts };
    return { data: undefined };
  },
}));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));

import { useRouter } from "../lib/router";
import { AccountUsage } from "./AccountUsage";

afterEach(cleanup);

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
