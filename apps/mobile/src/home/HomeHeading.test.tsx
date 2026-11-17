// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectLabel, SectionToggle } from "./HomeHeading";

afterEach(cleanup);

it("folds a part of the list from its label, naming Pinned's count but none on Resolved", () => {
  const toggled = vi.fn();
  const pinned = render(<SectionToggle section={{ kind: "section", key: "pinned:threads", part: "pinned", label: "Pinned", count: 2, open: true }} motion={{}} onToggle={toggled} />);
  const button = pinned.getByRole("button", { name: "Pinned, 2" });
  expect(button.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(button);
  expect(toggled).toHaveBeenCalledOnce();
  cleanup();
  const resolved = render(<SectionToggle section={{ kind: "section", key: "resolved-open:threads", part: "resolved", label: "Resolved", open: false }} motion={{}} onToggle={toggled} />);
  expect(resolved.getByRole("button", { name: "Resolved" }).getAttribute("aria-expanded")).toBe("false");
});

it("heads a project's group with its name and, at the end, what waits on the person, folding it from the label", () => {
  const toggled = vi.fn();
  const view = render(<ProjectLabel group={{ kind: "project", key: "project:openorc", project: { id: "openorc", name: "openorc" }, open: true, waiting: 2 }} motion={{}} onToggle={toggled} />);
  const button = view.getByRole("button", { name: "openorc, 2 need you" });
  expect(button.textContent).toBe("openorc2");
  fireEvent.click(button);
  expect(toggled).toHaveBeenCalledOnce();
  cleanup();
  const quiet = render(<ProjectLabel group={{ kind: "project", key: "project:p", project: { id: "p", name: "notes-app", cloud: true }, open: false, waiting: 0 }} motion={{}} onToggle={toggled} />);
  expect(quiet.getByRole("button", { name: "notes-app" }).getAttribute("aria-expanded")).toBe("false");
});
