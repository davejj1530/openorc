import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MacStartPlan, RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { useMacStart } from "./MacStartLine";

let plan: MacStartPlan;
const asked: unknown[] = [];
const seen: { macWork: unknown; refusal: string | null }[] = [];

beforeEach(() => {
  queryClient.clear();
  plan = {
    state: "ready",
    commits: [
      { sha: "1111111aaaa", subject: "Add refunds" },
      { sha: "2222222bbbb", subject: "Name the route" },
    ],
    changed: ["src/billing.ts", "src/billing.test.ts", "README.md"],
    added: ["src/refunds.ts"],
    held: [".env.local", "certs/dev.pem"],
    bytes: 48 * 1024,
    largest: [],
    refusal: null,
  };
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    if (method !== "hostedMacStart.plan") return {} as RpcResults[M];
    asked.push(params);
    const include = (params as { include: string[] }).include;
    const answered = plan.state === "ready" ? { ...plan, held: plan.held.filter((file) => !include.includes(file)), added: [...plan.added, ...include].sort() } : plan;
    return answered as RpcResults[M];
  });
});
afterEach(() => {
  cleanup();
  asked.length = 0;
  seen.length = 0;
  vi.restoreAllMocks();
});

function Harness() {
  const { line, macWork, refusal } = useMacStart("mac-project", undefined, true);
  seen.push({ macWork, refusal });
  return <div>{line}</div>;
}
const mount = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );

it("says what goes, commits ahead counted, with the held-back reason only on hover, and its files on demand", async () => {
  mount();
  const line = await screen.findByRole("status", { name: "From this Mac" });
  expect(line.textContent).toContain("From this Mac: 2 commits, 3 changed files and 1 new · 48 KB · 2 held back");
  expect(
    within(line)
      .getByText(/2 held back/)
      .getAttribute("data-tip"),
  ).toBe("They look like secrets.");
  expect(within(line).queryByText("Add refunds", { exact: false })).toBeNull();
  fireEvent.click(within(line).getByRole("button", { name: "Files" }));
  expect(within(line).getByText("1111111 Add refunds")).toBeTruthy();
  expect(within(line).getByText("src/refunds.ts")).toBeTruthy();
  expect(within(line).getByRole("checkbox", { name: "Send .env.local" })).toHaveProperty("checked", false);
  expect(seen.at(-1)).toEqual({ macWork: { include: [] }, refusal: null });
});

it("sends a held-back file the person ticks", async () => {
  mount();
  const line = await screen.findByRole("status", { name: "From this Mac" });
  fireEvent.click(within(line).getByRole("button", { name: "Files" }));
  fireEvent.click(within(line).getByRole("checkbox", { name: "Send .env.local" }));
  await waitFor(() => expect(asked.at(-1)).toMatchObject({ include: [".env.local"] }));
  await waitFor(() => expect(screen.getByRole("status", { name: "From this Mac" }).textContent).toContain("1 held back"));
  expect(screen.getByRole("checkbox", { name: "Send .env.local" })).toHaveProperty("checked", true);
  expect(seen.at(-1)?.macWork).toEqual({ include: [".env.local"] });
});

it("says why it can't go, naming the largest file, and holds Start with the same words", async () => {
  plan = { ...(plan as Extract<MacStartPlan, { state: "ready" }>), refusal: "Too large to send from this Mac: video.bin (51 MB), over 50 MB each." };
  mount();
  const line = await screen.findByRole("status", { name: "From this Mac" });
  expect(line.textContent).toBe("Too large to send from this Mac: video.bin (51 MB), over 50 MB each.");
  expect(seen.at(-1)?.refusal).toBe("Too large to send from this Mac: video.bin (51 MB), over 50 MB each.");
});

it("shows nothing when the folder holds nothing new, or the start isn't offered", async () => {
  plan = { state: "nothing" };
  mount();
  await waitFor(() => expect(asked.length).toBeGreaterThan(0));
  expect(screen.queryByRole("status")).toBeNull();
  expect(seen.at(-1)).toEqual({ macWork: undefined, refusal: null });
});
