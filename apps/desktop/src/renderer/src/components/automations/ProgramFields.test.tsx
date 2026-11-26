import type { TriggerState } from "@openorc/protocol";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../../lib/client";
import { core } from "../../lib/rpc";
import { ProgramFields } from "./ProgramFields";

vi.mock("../../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("../ModelPicker", () => ({
  ComposerModelPicker: ({ value }: { value: { model: string } | null }) => <span>{value?.model ?? "No model"}</span>,
  defaultChoice: () => ({ agent: "codex", model: "gpt-6-astra", effort: "high" }),
}));

const id = "6f1c2c1e-2b55-4a35-9a3f-1d8f3c0b9a11";
let trigger: TriggerState;
const writer = { choice: null, choose: () => {} };

function Fields({ enabled = true, written = true }: { enabled?: boolean; written?: boolean }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ProgramFields trigger={{ kind: "program", id: written ? id : "", what: "Someone messages me on Slack" }} project={undefined} writer={writer} enabled={enabled} onChange={() => {}} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  trigger = {
    id,
    run: "node watch.mjs",
    env: [{ name: "SLACK_APP_TOKEN", about: "From your Slack app's Basic Information page.", added: false }],
    threadId: "thread-1",
    state: "stopped",
    problem: "Add SLACK_APP_TOKEN to start it.",
    recent: [],
  };
  vi.mocked(core.call).mockImplementation(async (method) => {
    if (method === "automations.trigger") return trigger as never;
    if (method === "automations.setTriggerValue" || method === "automations.tryTrigger") return null as never;
    if (method === "agents.modelCatalog") return { models: [], providers: [] } as never;
    if (method === "app.settings.get") return {} as never;
    throw new Error(`Unexpected call: ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.clearAllMocks();
});

it("asks for the values the program names, and keeps one once its field is left", async () => {
  render(<Fields />);
  expect((await screen.findByRole("status")).textContent).toBe("Add SLACK_APP_TOKEN to start it.");
  expect(screen.getByText("From your Slack app's Basic Information page.")).toBeTruthy();
  const field = screen.getByLabelText("SLACK_APP_TOKEN");
  fireEvent.change(field, { target: { value: "xapp-1" } });
  fireEvent.blur(field);
  await waitFor(() => expect(vi.mocked(core.call).mock.calls.find(([method]) => method === "automations.setTriggerValue")?.[1]).toEqual({ id, name: "SLACK_APP_TOKEN", value: "xapp-1" }));
  expect(screen.getByRole("button", { name: "Open the code" })).toBeTruthy();
});

it("shows what a listening program printed lately, its events apart from its own words", async () => {
  trigger = {
    ...trigger,
    env: [{ ...trigger.env[0]!, added: true }],
    state: "listening",
    problem: null,
    recent: [
      { at: 1, text: "Connected", event: false },
      { at: 2, text: "Dana messaged you", event: true },
    ],
  };
  render(<Fields />);
  expect((await screen.findByRole("status")).textContent).toBe("Listening.");
  expect(screen.getByText("Connected").className).toContain("automation-program-said");
  expect(screen.getByText("Dana messaged you").className).not.toContain("automation-program-said");
  expect(screen.queryByRole("button", { name: "Try it" })).toBeNull();
});

it("offers a try while its automation is off, and says the agent is still writing a program with no command yet", async () => {
  trigger = { ...trigger, env: [], state: "off", problem: null };
  render(<Fields enabled={false} />);
  fireEvent.click(await screen.findByRole("button", { name: "Try it" }));
  await waitFor(() => expect(vi.mocked(core.call).mock.calls.find(([method]) => method === "automations.tryTrigger")?.[1]).toEqual({ id, on: true }));
  cleanup();
  queryClient.clear();
  trigger = { ...trigger, run: null };
  render(<Fields />);
  expect((await screen.findByRole("status")).textContent).toBe("An agent is writing it.");
});

it("describes a new one in words, on the model that will write it", () => {
  render(<Fields written={false} />);
  expect((screen.getByRole("textbox", { name: "What to watch for" }) as HTMLTextAreaElement).value).toBe("Someone messages me on Slack");
  expect(vi.mocked(core.call).mock.calls.some(([method]) => method === "automations.trigger")).toBe(false);
});
