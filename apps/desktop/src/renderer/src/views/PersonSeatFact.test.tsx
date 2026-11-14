import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PersonSeatFact, type PersonSeatFactProps } from "./PersonSeatFact";

afterEach(cleanup);
const person: PersonSeatFactProps["person"] = { userId: "person-b", plan: "pro", seat: { id: "seat-a", paysForPro: true } };
const admin: PersonSeatFactProps["viewer"] = { userId: "person-a", role: "admin" };
const member: PersonSeatFactProps["viewer"] = { userId: "person-a", role: "member" };

it("shows an admin the permitted seat and their own-payment detail on demand", async () => {
  const result = render(<PersonSeatFact person={person} viewer={admin} />);
  expect(screen.getByText("Seat")).toBeTruthy();
  expect(screen.queryByText("Also pays for Pro themselves.")).toBeNull();
  fireEvent.focus(result.container.querySelector(".person-seat-wide [tabindex]")!);
  expect(await screen.findByText("Also pays for Pro themselves.")).toBeTruthy();
});

it("hides another person's private facts from a member even when a cached row includes them", () => {
  const result = render(<PersonSeatFact person={person} viewer={member} />);
  expect(result.container.textContent).toBe("Pro");
  expect(result.container.querySelector("[tabindex], [data-tip]")).toBeNull();
});

it("shows a member their own seat detail at narrow widths", async () => {
  const result = render(<PersonSeatFact person={person} viewer={{ userId: person.userId, role: "member" }} />);
  fireEvent.focus(result.container.querySelector(".person-seat-compact [tabindex]")!);
  expect(await screen.findByText("Seat. Also pays for Pro themselves.")).toBeTruthy();
});

it("removes a cached private fact and an open tooltip immediately on demotion", async () => {
  const result = render(<PersonSeatFact person={person} viewer={admin} />);
  fireEvent.focus(result.container.querySelector(".person-seat-wide [tabindex]")!);
  await screen.findByText("Also pays for Pro themselves.");
  result.rerender(<PersonSeatFact person={person} viewer={member} />);
  expect(result.container.textContent).toBe("Pro");
  expect(screen.queryByText("Also pays for Pro themselves.")).toBeNull();
});

it("names personal payment only from the permitted fact without inferring a seat", async () => {
  const result = render(<PersonSeatFact person={{ ...person, seat: { id: null, paysForPro: true } }} viewer={admin} />);
  expect(screen.queryByText("Seat")).toBeNull();
  fireEvent.focus(result.container.querySelector("[tabindex]")!);
  expect(await screen.findByText("Pays for Pro themselves.")).toBeTruthy();
});

it.each([null, undefined])("keeps public plan words without inventing facts from an absent seat projection", (seat) => {
  const result = render(<PersonSeatFact person={{ ...person, plan: "free", seat }} viewer={admin} />);
  expect(result.container.textContent).toBe("Free");
  expect(result.container.querySelector("[tabindex], [data-tip]")).toBeNull();
});
