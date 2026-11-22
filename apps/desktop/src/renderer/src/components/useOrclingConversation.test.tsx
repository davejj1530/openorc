import { defaultOrclingLook, type ModelOption, type Orcling, type SystemInfo, type ThreadSummary } from "@openorc/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useOrclingConversation } from "./useOrclingConversation";

const host = vi.hoisted(() => ({ call: vi.fn(), separate: false }));
vi.mock("../lib/rpc", () => ({ core: { call: host.call, onReady: () => {}, onPush: () => () => {} } }));
vi.mock("./EffortGalaxy", () => ({ EffortGalaxy: () => null }));
vi.mock("./FastModeRocket", () => ({ FastModeRocket: () => null }));

const info = { dataDir: "/data", harnesses: [{ id: "claude", state: "ready", path: "/bin/claude", version: "1", revision: 0 }], gh: { installed: false, path: null } } as SystemInfo;
const models: ModelOption[] = [{ id: "sonnet", label: "Sonnet", agent: "claude", isDefault: true, efforts: [], defaultEffort: null }];
const orcling = (id: string, name: string, claudeAccountId: string) =>
  ({ id, name, claudeAccountId, threadId: `${id}-home`, look: defaultOrclingLook, settings: { agent: "claude", model: "sonnet", effort: null, fastMode: false } }) as unknown as Orcling;
const thread = { id: "thread", projectId: "project", agent: "claude", model: "sonnet", claudeAccountId: "work", orclingId: null, teamInstanceId: null } as unknown as ThreadSummary;
const answers = (): Record<string, unknown> => ({
  "app.settings.get": { claudeAccountsSeparate: host.separate, enabledHarnesses: ["claude"] },
  "orclings.list": [orcling("pip", "Pip", "work"), orcling("bo", "Bo", "personal")],
  "orclings.groups.list": [{ threadId: "group", title: "Pip and Bo", memberIds: ["pip", "bo"], createdAt: 1 }],
  "agents.modelCatalog": { models, providers: [] },
  "system.info": info,
});
const calls = (method: string) => host.call.mock.calls.filter(([name]) => name === method).map(([, params]) => params);

function Harness() {
  const orclings = useOrclingConversation({ thread, runs: [], choice: { agent: "claude", model: "sonnet", effort: null }, onModel: () => {} });
  const [asked, setAsked] = useState<boolean>();
  return (
    <>
      {orclings.modelControl}
      <ul aria-label="Can be asked">
        {orclings.mentions?.map((entry) => (
          <li key={entry.key}>{entry.name}</li>
        ))}
      </ul>
      <button type="button" onClick={() => void orclings.ask("@Bo what do you think?", []).then(setAsked)}>
        Send to Bo
      </button>
      {asked === undefined ? null : <output>{asked ? "Bo was asked" : "Sent as a message"}</output>}
    </>
  );
}
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Harness />
    </QueryClientProvider>,
  );
const askable = () => screen.getAllByRole("listitem").map((item) => item.textContent);
async function orclingRow(name: string): Promise<HTMLButtonElement> {
  fireEvent.click(await screen.findByRole("button", { name: "Model and effort" }));
  fireEvent.click(await screen.findByRole("button", { name: "Orclings" }));
  return screen.findByRole<HTMLButtonElement>("button", { name: new RegExp(`^${name}`) });
}

beforeEach(() => {
  host.separate = false;
  host.call.mockImplementation(async (method: string) => answers()[method] ?? {});
});
afterEach(() => {
  cleanup();
  host.call.mockReset();
});

it("offers every Orcling in a conversation's model picker, and gives it the one chosen", async () => {
  show();
  const bo = await orclingRow("Bo");
  expect(bo.disabled).toBe(false);
  expect(bo.textContent).toBe("BoSonnet");
  fireEvent.click(bo);
  await waitFor(() => expect(calls("orclings.assign")).toEqual([{ threadId: "thread", orclingId: "bo" }]));
});

it("offers no Orcling on another Claude account while accounts are kept separate, and says why", async () => {
  host.separate = true;
  show();
  const bo = await orclingRow("Bo");
  await waitFor(() => expect(bo.disabled).toBe(true));
  expect(bo.textContent).toBe("BoOn another Claude account");
  expect(bo.getAttribute("data-tip")).toBe("Accounts are kept separate, so this conversation stays on its account.");
  fireEvent.click(bo);
  const pip = screen.getByRole<HTMLButtonElement>("button", { name: /^Pip/ });
  expect(pip.disabled).toBe(false);
  fireEvent.click(pip);
  await waitFor(() => expect(calls("orclings.assign")).toEqual([{ threadId: "thread", orclingId: "pip" }]));
});

it("asks an Orcling named with @, whatever its account", async () => {
  show();
  await waitFor(() => expect(askable()).toEqual(["Pip", "Bo"]));
  fireEvent.click(screen.getByRole("button", { name: "Send to Bo" }));
  expect((await screen.findByRole("status")).textContent).toBe("Bo was asked");
  expect(calls("orclings.ask")).toEqual([{ id: "bo", threadId: "thread", prompt: "@Bo what do you think?", attachments: [] }]);
});

it("sends a message naming an Orcling on another account as an ordinary one while accounts are kept separate", async () => {
  host.separate = true;
  show();
  await waitFor(() => expect(askable()).toEqual(["Pip"]));
  fireEvent.click(screen.getByRole("button", { name: "Send to Bo" }));
  expect((await screen.findByRole("status")).textContent).toBe("Sent as a message");
  expect(calls("orclings.ask")).toEqual([]);
});

function GroupHarness() {
  const group = { ...thread, id: "group", projectId: "workspace" } as ThreadSummary;
  const orclings = useOrclingConversation({ thread: group, runs: [], choice: null, onModel: () => {} });
  return <output>{orclings.placeholder ? (orclings.disabledReason ?? "Can send") : "Loading"}</output>;
}
const showGroup = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <GroupHarness />
    </QueryClientProvider>,
  );

it("holds a group of Orclings on different Claude accounts while accounts are kept separate, in the core's words", async () => {
  host.separate = true;
  showGroup();
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("This group's Orclings work on different Claude accounts, and Settings keeps Claude accounts separate, so it waits until that's off."),
  );
});

it("lets a group of Orclings on different Claude accounts talk while the setting to keep them separate is off", async () => {
  showGroup();
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Can send"));
});
