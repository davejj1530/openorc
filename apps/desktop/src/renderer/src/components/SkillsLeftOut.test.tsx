import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LeftOutSkill, RpcMethod, RpcResults } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { SkillsLeftOut } from "./SkillsLeftOut";

let left: LeftOutSkill[];

beforeEach(() => {
  queryClient.clear();
  localStorage.clear();
  left = [{ name: "ui-ux-pro-max", cause: "its link data points to something that is no longer there." }];
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M): Promise<RpcResults[M]> => (method === "hostedSkills.leftOut" ? left : {}) as RpcResults[M]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mount = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <SkillsLeftOut agent="codex" on />
    </QueryClientProvider>,
  );

it("says once, in the muted ink, which skill was left out and why, and again only when the cause changes", async () => {
  const first = mount();
  const line = await screen.findByRole("status");
  expect(line.textContent).toBe("Sent without your skill ui-ux-pro-max: its link data points to something that is no longer there.");
  expect(line.className).toContain("text-ink-3");
  expect(line.className).not.toContain("text-bad");
  first.unmount();
  queryClient.clear();
  mount();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole("status")).toBeNull();
  cleanup();
  queryClient.clear();
  left = [{ name: "ui-ux-pro-max", cause: "its file data/tokens.json can't be read." }];
  mount();
  expect((await screen.findByRole("status")).textContent).toBe("Sent without your skill ui-ux-pro-max: its file data/tokens.json can't be read.");
});

it("says every skill was left out when this Mac couldn't list the agent's skills", async () => {
  left = [{ name: null, cause: "Codex on this Mac couldn't list them." }];
  mount();
  expect((await screen.findByRole("status")).textContent).toBe("Sent without your skills: Codex on this Mac couldn't list them.");
});
