// @vitest-environment jsdom
import type { TeamChatLease } from "@openorc/client";
import type { TeamOrclingCall } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CallLine } from "./CallLine";

const owned = vi.hoisted(() => ({ data: undefined as { reason: string | null; canRetry: boolean } | undefined }));
vi.mock("../client", () => ({ teamChat: { useOwnerCall: () => ({ data: owned.data }) } }));
vi.mock("../orclings/OrclingFace", () => ({ OrclingFace: () => null }));

afterEach(() => {
  cleanup();
  owned.data = undefined;
});

const lease = { accountId: "u-riley", spaceId: "org-birch", generation: 1, reach: "live", current: () => true } as TeamChatLease;
const call = (state: TeamOrclingCall["state"], ownerId = "u-riley") =>
  ({ id: "call-1", owner: { id: ownerId, name: "Riley Chen", image: null }, localOrclingId: "o1", name: "Pip", look: {}, state }) as unknown as TeamOrclingCall;

it("says the Orcling is answering, and nothing once it answered", () => {
  const { container, rerender } = render(<CallLine lease={lease} call={call("running")} mine onRetry={vi.fn()} />);
  expect(container.textContent).toBe("Pip is answering…");
  rerender(<CallLine lease={lease} call={call("answered")} mine onRetry={vi.fn()} />);
  expect(container.textContent).toBe("");
});

it("lets the owner of a failed call try again and read why it failed, and no one else", () => {
  owned.data = { reason: "Your Mac is asleep.", canRetry: true };
  const onRetry = vi.fn();
  render(<CallLine lease={lease} call={call("failed")} mine onRetry={onRetry} />);
  expect(screen.queryByText("Your Mac is asleep.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Pip couldn't answer" }));
  expect(screen.getByText("Your Mac is asleep.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ id: "call-1" }));
  cleanup();
  owned.data = undefined;
  render(<CallLine lease={lease} call={call("failed", "u-mara")} mine={false} onRetry={onRetry} />);
  expect(screen.getByText("Pip couldn't answer")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});
