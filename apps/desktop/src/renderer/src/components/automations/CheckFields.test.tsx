import type { AutomationTrigger, CheckWriting } from "@openorc/protocol";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../../lib/client";
import { core } from "../../lib/rpc";
import { CheckFields } from "./CheckFields";

vi.mock("../../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("../ModelPicker", () => ({
  ComposerModelPicker: ({ value }: { value: { model: string } | null }) => <span>{value?.model ?? "No model"}</span>,
  defaultChoice: () => ({ agent: "codex", model: "gpt-6-astra", effort: "high" }),
}));

type Check = Extract<AutomationTrigger, { kind: "check" }>;
let written: CheckWriting;
const asked: unknown[] = [];

function Form({ start }: { start: Check }) {
  const [trigger, setTrigger] = useState(start);
  return (
    <QueryClientProvider client={queryClient}>
      <CheckFields trigger={trigger} projectId="studio" project={undefined} onChange={setTrigger} />
      <output data-testid="every">{trigger.everyMinutes}</output>
    </QueryClientProvider>
  );
}
const empty: Check = { kind: "check", what: "", command: "", everyMinutes: 5 };

beforeEach(() => {
  asked.length = 0;
  vi.mocked(core.call).mockImplementation(async (method, input) => {
    if (method === "agents.modelCatalog") return { models: [], providers: [] } as never;
    if (method === "app.settings.get") return {} as never;
    if (method === "automations.writeCheck") {
      asked.push(input);
      return written as never;
    }
    if (method === "automations.tryCheck") return { state: "ran", found: [] } as never;
    throw new Error(`Unexpected call: ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.clearAllMocks();
});

it("writes a check from the words on the model shown, and says what it finds now and that only new ones count", async () => {
  written = { state: "written", command: "gh issue list --label bug", everyMinutes: 15, found: ["#212 Login page is blank", "#208 Columns flicker", "#197 Dictation stops", "#190 Wrong week"] };
  render(<Form start={empty} />);
  fireEvent.change(screen.getByRole("textbox", { name: "What to watch for" }), { target: { value: "An issue opens with the bug label" } });
  await waitFor(() => expect(screen.getByText("gpt-6-astra")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Write the check" }));
  await screen.findByText("It finds 4 now. They are already there, so only new ones set it off.");
  expect(asked).toEqual([{ projectId: "studio", what: "An issue opens with the bug label", choice: { agent: "codex", model: "gpt-6-astra", effort: "high" } }]);
  expect(screen.getByText("#212 Login page is blank")).toBeTruthy();
  expect(screen.getByText("And 1 more")).toBeTruthy();
  expect(screen.getByTestId("every").textContent).toBe("15");
  fireEvent.click(screen.getByRole("button", { name: "Show the command" }));
  expect((screen.getByRole("textbox", { name: "The check's command" }) as HTMLTextAreaElement).value).toBe("gh issue list --label bug");
  expect(screen.getByRole("button", { name: "Write it again" })).toBeTruthy();
});

it("says why a check did not run, and opens the command it wrote to be fixed", async () => {
  written = { state: "failed", reason: "The check it wrote did not run. gh: not signed in.", command: "gh issue list" };
  render(<Form start={{ ...empty, what: "New issues" }} />);
  await waitFor(() => expect(screen.getByText("gpt-6-astra")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Write the check" }));
  expect((await screen.findByRole("alert")).textContent).toBe("The check it wrote did not run. gh: not signed in.");
  expect((screen.getByRole("textbox", { name: "The check's command" }) as HTMLTextAreaElement).value).toBe("gh issue list");
});

it("runs a command written by hand once with Try it", async () => {
  render(<Form start={empty} />);
  fireEvent.click(screen.getByRole("button", { name: "Write the command yourself" }));
  fireEvent.change(screen.getByRole("textbox", { name: "The check's command" }), { target: { value: "ls releases" } });
  fireEvent.click(screen.getByRole("button", { name: "Try it" }));
  await screen.findByText("It finds nothing right now, and looks again every 5 minutes.");
  expect(vi.mocked(core.call).mock.calls.find(([method]) => method === "automations.tryCheck")?.[1]).toEqual({ projectId: "studio", command: "ls releases" });
});
