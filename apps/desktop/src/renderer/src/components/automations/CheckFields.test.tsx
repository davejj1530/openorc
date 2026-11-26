import type { AutomationTrigger } from "@openorc/protocol";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../../lib/client";
import { core } from "../../lib/rpc";
import { CheckFields } from "./CheckFields";

vi.mock("../../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));

type Check = Extract<AutomationTrigger, { kind: "check" }>;

function Form({ start }: { start: Check }) {
  const [trigger, setTrigger] = useState(start);
  return (
    <QueryClientProvider client={queryClient}>
      <CheckFields trigger={trigger} projectId="studio" onChange={setTrigger} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(core.call).mockImplementation(async (method) => {
    if (method === "automations.tryCheck") return { state: "ran", found: ["#212 Login page is blank", "#208 Columns flicker", "#197 Dictation stops", "#190 Wrong week"] } as never;
    throw new Error(`Unexpected call: ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.clearAllMocks();
});

it("runs a check's command once with Try it, and says what it finds now and that only new ones count", async () => {
  render(<Form start={{ kind: "check", what: "New bugs", command: "", everyMinutes: 5 }} />);
  fireEvent.change(screen.getByRole("textbox", { name: "The check's command" }), { target: { value: "gh issue list --label bug" } });
  fireEvent.click(screen.getByRole("button", { name: "Try it" }));
  await screen.findByText("It finds 4 now. They are already there, so only new ones set it off.");
  expect(vi.mocked(core.call).mock.calls.find(([method]) => method === "automations.tryCheck")?.[1]).toEqual({ projectId: "studio", command: "gh issue list --label bug" });
  expect(screen.getByText("And 1 more")).toBeTruthy();
});
