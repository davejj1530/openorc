import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Connector, ConnectorList, HostedConnector, HostedConnectors, RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { ConnectorSettings } from "./settings-connectors";

const on = { agent: "claude" as const, source: "user" as const, editable: true, switchable: true, places: [{ status: "connected" as const }] };
const connector = (name: string, extra: Partial<Connector>): Connector => ({ name, title: name, kind: "url", logo: null, agents: [on], ...extra });
const list: ConnectorList = {
  connectors: [connector("tracker", {}), connector("local-files", { kind: "command" }), connector("signed-in-only", { agents: [{ ...on, places: [{ status: "needs-sign-in" }] }] })],
  unavailable: [],
  checking: false,
  signIn: null,
  signInError: null,
};
const kept = (extra: Partial<HostedConnector> = {}): HostedConnector => ({
  agent: "claude",
  name: "tracker",
  url: "https://mcp.tools-example.com/mcp",
  headers: [{ name: "authorization", updatedAt: 1 }],
  revision: 1,
  updatedAt: 1,
  check: { status: "connected", message: null },
  ...extra,
});
let cloud: HostedConnectors;
const calls: { method: string; params: unknown }[] = [];

beforeEach(() => {
  queryClient.clear();
  cloud = { state: "ready", connectors: [] };
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    calls.push({ method, params });
    if (method === "connectors.list") return list as RpcResults[M];
    if (method === "hostedConnectors.read") return cloud as RpcResults[M];
    if (method === "connectors.spec") return { kind: "url", url: "https://mcp.tools-example.com/mcp", headers: { authorization: "Bearer mac-value" } } as RpcResults[M];
    if (method === "hostedConnectors.save") {
      cloud = { state: "ready", connectors: [kept()] };
      return cloud as RpcResults[M];
    }
    if (method === "hostedConnectors.remove") {
      cloud = { state: "ready", connectors: [] };
      return cloud as RpcResults[M];
    }
    return {} as RpcResults[M];
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
const card = async (name: string) => within(await screen.findByRole("listitem", { name }));

it("adds no cloud line where the server keeps no connectors", async () => {
  cloud = { state: "unavailable" };
  mount();
  await card("tracker");
  await waitFor(() => expect(calls.some((call) => call.method === "hostedConnectors.read")).toBe(true));
  expect(screen.queryByText("OpenOrc Cloud")).toBeNull();
});

it("offers Set up for an HTTPS connector, and says on demand why a command or a sign-in one can't be", async () => {
  mount();
  expect(await (await card("tracker")).findByText("Not set up")).toBeTruthy();
  expect((await card("tracker")).getByRole("button", { name: "Set up tracker in the cloud" })).toHaveProperty("disabled", false);
  const command = (await card("local-files")).getByRole("button", { name: "Set up local-files in the cloud" });
  expect(command).toHaveProperty("disabled", true);
  expect(command.parentElement?.getAttribute("data-tip")).toBe("This connector runs on your Mac.");
  expect((await card("signed-in-only")).getByRole("button", { name: "Set up signed-in-only in the cloud" }).parentElement?.getAttribute("data-tip")).toBe(
    "This connector needs a cloud sign-in that isn't available yet.",
  );
});

it("sets one up from this Mac's address, reads its headers only when asked, saves for its agents and shows them", async () => {
  mount();
  fireEvent.click(await (await card("tracker")).findByRole("button", { name: "Set up tracker in the cloud" }));
  const sheet = within(await screen.findByRole("dialog", { name: "tracker in the cloud" }));
  await waitFor(() => expect((sheet.getByRole("textbox", { name: "Server address" }) as HTMLInputElement).value).toBe("https://mcp.tools-example.com/mcp"));
  expect(sheet.queryByRole("textbox", { name: "Header 1" })).toBeNull();
  fireEvent.click(sheet.getByRole("button", { name: "Use this Mac's headers" }));
  await waitFor(() => expect((sheet.getByRole("textbox", { name: "Header 1" }) as HTMLInputElement).value).toBe("authorization"));
  expect((sheet.getByLabelText("Value 1") as HTMLInputElement).value).toBe("Bearer mac-value");
  // This Mac's address is a plain one here: the sheet says why it can't be used before anything is sent.
  fireEvent.change(sheet.getByRole("textbox", { name: "Server address" }), { target: { value: "http://127.0.0.1:4000/mcp" } });
  fireEvent.click(sheet.getByRole("button", { name: "Save" }));
  expect((await sheet.findByRole("alert")).textContent).toBe("A connector in the cloud is reached over HTTPS.");
  expect(calls.some((call) => call.method === "hostedConnectors.save")).toBe(false);
  fireEvent.change(sheet.getByRole("textbox", { name: "Server address" }), { target: { value: "https://mcp.tools-example.com/mcp" } });
  expect(sheet.queryByRole("alert")).toBeNull();
  fireEvent.click(sheet.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls.find((call) => call.method === "hostedConnectors.save")?.params).toEqual({
    name: "tracker",
    url: "https://mcp.tools-example.com/mcp",
    headers: [{ name: "authorization", value: "Bearer mac-value" }],
    agents: ["claude"],
  });
  expect(await (await card("tracker")).findAllByText("Claude Code")).toHaveLength(2);
});

it("reopens a saved one with its values kept unless retyped, says a refused check, and removes it", async () => {
  cloud = { state: "ready", connectors: [kept({ check: { status: "refused", message: "The connector refused these headers." } })] };
  mount();
  const status = await (await card("tracker")).findByText("Refused its headers");
  expect(status.getAttribute("data-tip")).toBe("The connector refused these headers.");
  fireEvent.click((await card("tracker")).getByRole("button", { name: "Edit tracker in the cloud" }));
  const sheet = within(await screen.findByRole("dialog", { name: "tracker in the cloud" }));
  expect(sheet.getByLabelText("Value 1").getAttribute("placeholder")).toBe("Saved");
  expect(sheet.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  // A saved one's headers are never read from this Mac unless asked.
  expect(calls.some((call) => call.method === "connectors.spec")).toBe(false);
  fireEvent.change(sheet.getByRole("textbox", { name: "Server address" }), { target: { value: "https://mcp.tools-example.com/v2" } });
  fireEvent.click(sheet.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(calls.find((call) => call.method === "hostedConnectors.save")?.params).toMatchObject({ url: "https://mcp.tools-example.com/v2", headers: [{ name: "authorization", keep: true }] }),
  );
  fireEvent.click((await card("tracker")).getByRole("button", { name: "Edit tracker in the cloud" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove from the cloud" }));
  await waitFor(() => expect(calls.some((call) => call.method === "hostedConnectors.remove")).toBe(true));
  expect(await (await card("tracker")).findByText("Not set up")).toBeTruthy();
});
