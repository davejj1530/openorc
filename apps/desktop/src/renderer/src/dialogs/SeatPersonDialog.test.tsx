import type { OrganizationSeat } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SeatPersonDialog, type SeatPerson } from "./SeatPersonDialog";

afterEach(cleanup);
const seat: OrganizationSeat = {
  id: "seat-a",
  assignment: { kind: "available" },
  period: { startsAt: 1000, endsAt: 2000 },
  included: { grantedSeconds: 360000, usedSeconds: 36000, leftSeconds: 324000 },
  retiresAt: null,
};
const person = (memberId: string, name: string, id: string | null): SeatPerson => ({ memberId, name, email: `${memberId}@example.com`, image: null, seat: { id, paysForPro: false } });
const people = [person("member-a", "Sam Example", null), person("member-b", "Alex Example", "seat-b")];

it("selects a person for this specific seat without choosing another balance", () => {
  const onReview = vi.fn();
  render(<SeatPersonDialog seat={seat} people={people} onReview={onReview} onClose={vi.fn()} />);
  expect(screen.getByText("90 h")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Review seat" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Sam Example" }));
  fireEvent.click(screen.getByRole("button", { name: "Review seat" }));
  expect(onReview).toHaveBeenCalledExactlyOnceWith("member-a");
  expect(screen.getByRole("radio", { name: "Alex Example" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Has a seat")).toBeTruthy();
});

it("allows a person who pays for Pro themselves when they have no seat here", () => {
  const onReview = vi.fn();
  render(<SeatPersonDialog seat={seat} people={[{ ...people[0]!, seat: { id: null, paysForPro: true } }]} onReview={onReview} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "Sam Example" }));
  fireEvent.click(screen.getByRole("button", { name: "Review seat" }));
  expect(onReview).toHaveBeenCalledWith("member-a");
  expect(screen.queryByText(/pays for Pro/)).toBeNull();
});

it("cannot confirm a person who left or acquired a seat while the picker was open", () => {
  const onReview = vi.fn(),
    props = { seat, onReview, onClose: vi.fn() };
  const view = render(<SeatPersonDialog {...props} people={people} />);
  fireEvent.click(screen.getByRole("radio", { name: "Sam Example" }));
  view.rerender(<SeatPersonDialog {...props} people={[person("member-a", "Sam Example", "seat-c"), people[1]!]} />);
  fireEvent.click(screen.getByRole("button", { name: "Review seat" }));
  expect(onReview).not.toHaveBeenCalled();
  view.rerender(<SeatPersonDialog {...props} people={[people[1]!]} />);
  expect(screen.queryByRole("radio", { name: "Sam Example" })).toBeNull();
  expect(screen.getByRole("button", { name: "Review seat" }).hasAttribute("disabled")).toBe(true);
});

it("does not treat missing private seat facts as proof that a person has no seat", () => {
  render(<SeatPersonDialog seat={seat} people={[{ ...people[0]!, seat: null }]} onReview={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole("radio", { name: "Sam Example" }).hasAttribute("disabled")).toBe(true);
  expect(screen.queryByText("Has a seat")).toBeNull();
  expect(document.querySelector('[data-tip="The seat details aren’t available. Read People again."]')).toBeTruthy();
});
