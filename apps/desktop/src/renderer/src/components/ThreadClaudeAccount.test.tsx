import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { ClaudeAccountConnection, ThreadSummary } from "@openorc/protocol";
import { ClaudeAccountScope } from "../lib/claude-account";
import { core } from "../lib/rpc";
import { ThreadClaudeAccount } from "./ThreadClaudeAccount";

const accounts = vi.hoisted(() => ({ list: [] as ClaudeAccountConnection[] }));
vi.mock("../lib/rpc", () => ({
  core: new Proxy({ call: vi.fn(async () => ({})) } as Record<string, unknown>, { get: (target, key: string) => (key in target ? target[key] : () => () => undefined) }),
}));
vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: () => ({ data: { defaultId: "work", accounts: accounts.list }, isLoading: false, isError: false, error: null }),
}));

afterEach(() => {
  cleanup();
  vi.mocked(core.call).mockReset().mockResolvedValue({});
});

const account = (id: string, name: string, status: ClaudeAccountConnection["status"] = "ready"): ClaudeAccountConnection => ({
  id,
  name,
  kind: "managed",
  enabled: status !== "disabled",
  createdAt: 1,
  status,
  email: null,
  organization: null,
  message: null,
});

function show(thread: Partial<ThreadSummary> = {}) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ClaudeAccountScope id="work">
        <ThreadClaudeAccount thread={{ id: "thread", agent: "claude", activity: "idle", claudeAccountId: "work", ...thread } as ThreadSummary} />
      </ClaudeAccountScope>
    </QueryClientProvider>,
  );
}

const switches = () => vi.mocked(core.call).mock.calls.filter(([method]) => method === "threads.switchClaudeAccount");

it("switches the conversation to another signed-in account, while one that can't run stays listed with its reason", async () => {
  accounts.list = [account("work", "Work"), account("personal", "Personal"), account("old", "Old", "signed_out")];
  show();
  fireEvent.click(screen.getByRole("button", { name: "Claude account: Work" }));
  const old = await screen.findByRole("menuitem", { name: "Old signed out" });
  expect(old.getAttribute("aria-disabled")).toBe("true");
  await act(async () => void fireEvent.click(screen.getByRole("menuitem", { name: "Personal" })));
  expect(switches()).toEqual([["threads.switchClaudeAccount", { id: "thread", claudeAccountId: "personal" }]]);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

it("waits for the turn to end, and stays a plain name with one account or for an Orcling", async () => {
  accounts.list = [account("work", "Work"), account("personal", "Personal")];
  show({ activity: "running" });
  fireEvent.click(screen.getByRole("button", { name: "Claude account: Work" }));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "Switch accounts when this turn ends.");
  await act(async () => void fireEvent.click(screen.getByRole("menuitem", { name: "Personal" })));
  expect(switches()).toEqual([]);
  cleanup();

  show({ orclingId: "orcling" });
  expect(screen.queryByRole("button", { name: /Claude account/ })).toBeNull();
  cleanup();
  accounts.list = [account("work", "Work")];
  show();
  expect([screen.queryByRole("button", { name: /Claude account/ }), screen.getByTitle("Claude account: Work").textContent]).toEqual([null, "Work"]);
});
