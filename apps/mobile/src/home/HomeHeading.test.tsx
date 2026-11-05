// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HomeHeading, SectionToggle } from "./HomeHeading";

afterEach(cleanup);

it("heads Needs you with how many wait, and never folds it", () => {
  const view = render(<HomeHeading heading={{ kind: "heading", key: "needs-you", title: "Needs you", count: 3 }} />);
  expect(view.getByLabelText("Needs you, 3")).toBeTruthy();
  expect(view.queryByRole("button")).toBeNull();
});

it("folds a part of the list from its label, naming Pinned's count but no day's", () => {
  const toggled = vi.fn();
  const pinned = render(<SectionToggle section={{ kind: "section", key: "pinned:threads", label: "Pinned", count: 2, open: true }} motion={{}} onToggle={toggled} />);
  const button = pinned.getByRole("button", { name: "Pinned, 2" });
  expect(button.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(button);
  expect(toggled).toHaveBeenCalledOnce();
  cleanup();
  const day = render(<SectionToggle section={{ kind: "section", key: "day-open:week", label: "Last 7 days", open: false }} motion={{}} onToggle={toggled} />);
  expect(day.getByRole("button", { name: "Last 7 days" }).getAttribute("aria-expanded")).toBe("false");
});
