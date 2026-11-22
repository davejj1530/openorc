import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultOrclingLook, type Orcling } from "@openorc/protocol";

const host = vi.hoisted(() => ({ separate: false, create: vi.fn() }));
vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string) => ({ data: method === "app.settings.get" ? { claudeAccountsSeparate: host.separate } : undefined }),
  useRpcMutation: () => ({ mutate: host.create, reset: vi.fn(), isPending: false, error: null }),
}));
vi.mock("./ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui")>()),
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

import { NewOrclingGroupButton } from "./OrclingGroups";

const orcling = (name: string, claudeAccountId: string) => ({ id: name, name, claudeAccountId, threadId: `${name}-thread`, look: defaultOrclingLook }) as unknown as Orcling;
const orclings = [orcling("Pip", "work"), orcling("Bo", "personal"), orcling("Nova", "work")];
const box = (name: string) => screen.getByRole<HTMLInputElement>("checkbox", { name });

beforeEach(() => {
  host.separate = false;
  host.create.mockReset();
});
afterEach(cleanup);

it("offers only Orclings on the first one's Claude account while accounts are kept separate, and says why", () => {
  host.separate = true;
  render(<NewOrclingGroupButton orclings={orclings} />);
  fireEvent.click(screen.getByRole("button", { name: "New group chat" }));
  expect(screen.queryByText("On another Claude account")).toBeNull();
  fireEvent.click(box("Pip"));
  expect(box("Bo").disabled).toBe(true);
  expect(box("Bo").closest("label")?.textContent).toBe("BoOn another Claude account");
  expect(document.getElementById(box("Bo").getAttribute("aria-describedby")!)?.textContent).toBe("On another Claude account");
  expect(box("Nova").getAttribute("aria-describedby")).toBeNull();
  expect(box("Nova").disabled).toBe(false);
  fireEvent.click(box("Nova"));
  fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
  expect(host.create.mock.calls[0]?.[0]).toEqual({ memberIds: ["Pip", "Nova"] });
});

it("offers every Orcling for a group while the setting to keep accounts separate is off", () => {
  render(<NewOrclingGroupButton orclings={orclings} />);
  fireEvent.click(screen.getByRole("button", { name: "New group chat" }));
  fireEvent.click(box("Pip"));
  expect(box("Bo").disabled).toBe(false);
  expect(screen.queryByText("On another Claude account")).toBeNull();
  fireEvent.click(box("Bo"));
  fireEvent.click(screen.getByRole("button", { name: "Start chat" }));
  expect(host.create.mock.calls[0]?.[0]).toEqual({ memberIds: ["Pip", "Bo"] });
});
