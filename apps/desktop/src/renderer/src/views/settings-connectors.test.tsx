import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Connector, ConnectorList, RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { ConnectorSettings } from "./settings-connectors";
import { SectionActionsSlot } from "./settings-shared";

const connector = (name: string, extra: Partial<Connector>): Connector => ({ name, title: name, kind: "url", logo: null, agents: [], ...extra });
const list: ConnectorList = {
  connectors: [
    connector("figma", {
      title: "Figma",
      agents: [
        { agent: "claude", source: "user", editable: true, switchable: true, places: [{ status: "connected" }] },
        { agent: "codex", source: "user", editable: true, switchable: true, places: [{ status: "off" }] },
      ],
    }),
    connector("linear", { title: "Linear", agents: [{ agent: "codex", source: "plugin", editable: false, switchable: false, places: [{ status: "needs-sign-in" }] }] }),
  ],
  unavailable: [],
  checking: false,
  signIn: null,
  signInError: null,
};
const calls: { method: string; params: unknown }[] = [];

beforeEach(() => {
  queryClient.clear();
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    calls.push({ method, params });
    return (method === "connectors.list" ? list : {}) as RpcResults[M];
  });
});
afterEach(() => {
  cleanup();
  calls.length = 0;
  vi.restoreAllMocks();
});

const mount = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <ConnectorSettings active />
    </QueryClientProvider>,
  );

it("shows each connector as a card with where it comes from and every agent's line and switch", async () => {
  mount();
  const figma = await screen.findByRole("listitem", { name: "Figma" });
  expect(within(figma).getByText("Remote server")).toBeTruthy();
  expect(within(figma).getByRole("switch", { name: "Figma in Claude Code" })).toHaveProperty("checked", true);
  expect(within(figma).getByRole("switch", { name: "Figma in Codex" })).toHaveProperty("checked", false);
  expect(within(figma).queryByRole("button", { name: "Sign in" })).toBeNull();
  const linear = screen.getByRole("listitem", { name: "Linear" });
  expect(within(linear).getByText("Remote server · From a plugin")).toBeTruthy();
  expect(within(linear).getByText("Needs sign-in")).toBeTruthy();
});

it("signs a connector in from its card", async () => {
  mount();
  const linear = await screen.findByRole("listitem", { name: "Linear" });
  fireEvent.click(within(linear).getByRole("button", { name: "Sign in" }));
  await vi.waitFor(() => expect(calls).toContainEqual({ method: "connectors.signIn", params: { name: "linear" } }));
});

it("puts its controls in the top bar's slot while it is the open section, and keeps them out while it is not", async () => {
  const slot = document.createElement("div");
  document.body.append(slot);
  const page = (active: boolean) => (
    <QueryClientProvider client={queryClient}>
      <SectionActionsSlot.Provider value={slot}>
        <main>
          <ConnectorSettings active={active} />
        </main>
      </SectionActionsSlot.Provider>
    </QueryClientProvider>
  );
  const { rerender } = render(page(true));
  expect(within(slot).getByRole("button", { name: "Add connector" })).toBeTruthy();
  expect(within(slot).getByRole("button", { name: "Check again" })).toBeTruthy();
  expect(within(screen.getByRole("main")).queryByRole("button", { name: "Add connector" })).toBeNull();
  rerender(page(false));
  expect(within(slot).queryByRole("button", { name: "Add connector" })).toBeNull();
  slot.remove();
});
