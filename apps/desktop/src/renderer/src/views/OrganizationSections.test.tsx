import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useOrganizationSection } from "../lib/organization-section";
import { useRouter } from "../lib/router";
import { OrganizationSections } from "./OrganizationSections";

beforeEach(() => useRouter.setState({ route: { view: "people", spaceId: "team-a" }, history: [], future: [], threadIds: [] }));
afterEach(cleanup);
function Sections() {
  const state = useOrganizationSection("team-a", true);
  return <OrganizationSections {...state} />;
}

it("keeps the section in organization history and supports keyboard tabs", () => {
  render(<Sections />);
  const people = screen.getByRole("tab", { name: "People" });
  const seats = screen.getByRole("tab", { name: "Seats" });
  fireEvent.keyDown(people, { key: "ArrowRight" });
  expect(seats.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(seats);
  expect(useRouter.getState().route).toEqual({ view: "people", spaceId: "team-a", section: "seats" });
  act(() => useRouter.getState().back());
  expect(useRouter.getState().route).toEqual({ view: "people", spaceId: "team-a" });
  act(() => useRouter.getState().forward());
  expect(useRouter.getState().route).toEqual({ view: "people", spaceId: "team-a", section: "seats" });
});
it("shows People for members and never reads another organization's saved section", () => {
  useRouter.setState({ route: { view: "people", spaceId: "team-a", section: "seats" } });
  const hook = renderHook(({ admin, spaceId }) => useOrganizationSection(spaceId, admin), { initialProps: { admin: true, spaceId: "team-a" } });
  expect(hook.result.current.section).toBe("seats");
  hook.rerender({ admin: false, spaceId: "team-a" });
  expect(hook.result.current.section).toBe("people");
  hook.rerender({ admin: true, spaceId: "team-b" });
  expect(hook.result.current.section).toBe("people");
});
