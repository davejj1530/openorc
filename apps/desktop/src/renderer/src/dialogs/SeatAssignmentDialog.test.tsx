import type { OrganizationSeatPreview, SeatAssignmentRequest, SeatAssignmentWork } from "@openorc/protocol";
import { accountDay, cloudTime, seatDeadline } from "@openorc/client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SeatAssignment } from "../lib/seat-assignment";
import { SeatAssignmentDialog, type SeatAssignmentDialogProps } from "./SeatAssignmentDialog";

const start = Date.parse("2026-11-01T00:00:00Z");
const person = { id: "person-a", name: "Sam Example", email: "sam@example.com", image: null };
const preview: OrganizationSeatPreview = {
  token: "preview-a",
  asOf: start,
  expiresAt: start + 60_000,
  seat: {
    id: "seat-a",
    assignment: { kind: "member", memberId: "member-a", person, paysForPro: false },
    included: { grantedSeconds: 360000, usedSeconds: 212400, leftSeconds: 147600 },
    period: { startsAt: start, endsAt: Date.parse("2026-12-01T00:00:00Z") },
    retiresAt: null,
  },
  to: { memberId: "member-b", person: { id: "person-b", name: "Alex Example", email: "alex@example.com", image: null } },
  previousHolderAfter: "grace",
  graceUntil: start + 86_400_000,
  runningTurnsToStop: 2,
};
const views: SeatAssignment[] = [];
afterEach(() => {
  cleanup();
  views.splice(0).forEach((view) => view.close());
});
async function show(read = preview, action: SeatAssignmentDialogProps["action"] = "move") {
  const deps = {
    current: () => true,
    now: () => start,
    id: () => crypto.randomUUID(),
    preview: vi.fn(async () => read),
    send: vi.fn<(request: SeatAssignmentRequest) => Promise<SeatAssignmentWork>>(async (request) => ({
      request,
      operation: { id: request.body.id, kind: "assignment", state: "pending", message: null },
      error: null,
    })),
    read: vi.fn<(id: string) => Promise<SeatAssignmentWork | null>>(async () => null),
  };
  const view = new SeatAssignment(deps),
    onClose = vi.fn();
  views.push(view);
  view.select({ seatId: read.seat.id, memberId: read.to?.memberId ?? null });
  await view.review();
  render(<SeatAssignmentDialog action={action} view={view} onClose={onClose} />);
  return { view, deps, onClose };
}

it("shows only the selected slot's hours, renewal and private grace outcome", async () => {
  await show();
  expect(screen.getByText("Sam Example")).toBeTruthy();
  expect(screen.getByText("Alex Example")).toBeTruthy();
  expect(screen.getByText(cloudTime(147600))).toBeTruthy();
  expect(screen.getByText(accountDay(preview.seat.period!.endsAt))).toBeTruthy();
  expect(screen.getByText(seatDeadline(preview.graceUntil!))).toBeTruthy();
  expect(screen.getByText("2 running turns will stop. Their work is saved.")).toBeTruthy();
  expect(screen.queryByText("100 h")).toBeNull();
});

it("shows a surviving Pro source without naming a payer or warning about zero running turns", async () => {
  await show({ ...preview, previousHolderAfter: "pro", graceUntil: null, runningTurnsToStop: 0 });
  expect(screen.getByText("Sam keeps Pro.")).toBeTruthy();
  expect(screen.queryByText(/running turns/)).toBeNull();
  expect(screen.queryByText(/pays|paid by/i)).toBeNull();
});

it("keeps an already frozen former holder frozen without inventing another grace deadline", async () => {
  await show({ ...preview, to: null, previousHolderAfter: "frozen", graceUntil: null, runningTurnsToStop: 0 }, "takeBack");
  expect(screen.getByText("They are already frozen.")).toBeTruthy();
  expect(screen.queryByText(/has until|keeps Pro/)).toBeNull();
});

it("shows Moving the seat while pending and Close leaves the saved change running", async () => {
  const f = await show();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Move seat" }));
  });
  expect(screen.getByText("Moving the seat.")).toBeTruthy();
  expect(screen.getByText("Sam Example")).toBeTruthy();
  expect(screen.getByText(cloudTime(147600))).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  fireEvent.click(screen.getByText("Close", { selector: "button" }));
  expect(f.onClose).toHaveBeenCalledTimes(1);
  expect(f.view.getSnapshot().state).toBe("pending");
  expect(f.deps.send).toHaveBeenCalledTimes(1);
});

it("does not present preview numbers as settled facts after a completed write and failed read", async () => {
  const f = await show();
  f.deps.send.mockImplementationOnce(async (request) => ({
    request,
    operation: { id: request.body.id, kind: "assignment", state: "complete", message: null },
    error: "OpenOrc Cloud can't be reached.",
  }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Move seat" }));
  });
  expect(screen.getByText("Seat moved.")).toBeTruthy();
  expect(screen.getByText("Sam Example")).toBeTruthy();
  expect(screen.getByText("Alex Example")).toBeTruthy();
  expect(screen.queryByText("Hours left")).toBeNull();
  expect(screen.queryByText(/turns stopped|has until/)).toBeNull();
  expect(screen.getByRole("alert").textContent).toBe("OpenOrc Cloud can't be reached.");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  });
  expect(f.deps.read).toHaveBeenCalledTimes(1);
  expect(f.deps.send).toHaveBeenCalledTimes(1);
});

it("offers Review again after a stale preview without repeating the mutation", async () => {
  const f = await show();
  f.deps.send.mockImplementationOnce(async (request) => ({
    request,
    operation: { id: request.body.id, kind: "assignment", state: "failed", message: "That seat has changed. Review the change again." },
    error: null,
  }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Move seat" }));
  });
  expect(screen.queryByRole("button", { name: "Move seat" })).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Review again" }));
  });
  expect(f.deps.preview).toHaveBeenCalledTimes(2);
  expect(f.deps.send).toHaveBeenCalledTimes(1);
});

it("takes back a seat without showing a recipient or a subscription quantity change", async () => {
  const f = await show({ ...preview, to: null }, "takeBack");
  expect(screen.queryByText("To")).toBeNull();
  expect(screen.queryByText(/Change seats|Cancel seats/)).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Take back seat" }));
  });
  expect(f.deps.send).toHaveBeenCalledTimes(1);
});

it.each([
  [
    "give",
    { ...preview, seat: { ...preview.seat, assignment: { kind: "available" as const } }, previousHolderAfter: null, graceUntil: null, runningTurnsToStop: 0 },
    "Give seat",
    "Giving the seat",
    "Seat given",
  ],
  ["takeBack", { ...preview, to: null }, "Take back seat", "Taking back the seat", "Seat taken back"],
  ["move", preview, "Move seat", "Moving the seat", "Seat moved"],
] as const)("words a %s by what happened while it runs and once it is done", async (action, read, confirm, running, done) => {
  const f = await show(read, action);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: confirm }));
  });
  expect(screen.getByRole("dialog", { name: running })).toBeTruthy();
  expect(screen.getByText(`${running}.`)).toBeTruthy();
  const request = f.deps.send.mock.calls[0]![0];
  act(() => f.view.resume({ request, operation: { id: request.body.id, kind: "assignment", state: "complete", message: null }, error: null }, read));
  expect(screen.getByRole("dialog", { name: done })).toBeTruthy();
  expect(screen.getByText(`${done}.`)).toBeTruthy();
});

it("words a reopened change by the server's preview, not the row it was reopened from", async () => {
  const given = { ...preview, seat: { ...preview.seat, assignment: { kind: "available" as const } } };
  const f = await show(given, "give");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Give seat" }));
  });
  cleanup();
  const request = f.deps.send.mock.calls[0]![0];
  f.view.resume({ request, operation: { id: request.body.id, kind: "assignment", state: "complete", message: null }, error: null }, given);
  render(<SeatAssignmentDialog action="move" view={f.view} onClose={f.onClose} />);
  expect(screen.getByRole("dialog", { name: "Seat given" })).toBeTruthy();
});
