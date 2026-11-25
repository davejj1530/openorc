// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CloudOutOfReach } from "../spaces/cloud-reach";
import { nativeProps } from "../test-fixtures/react-native";
import { ProjectLabel, ResolvedDoor, SectionToggle } from "./HomeHeading";

afterEach(cleanup);

it("folds a part of the list from its label, naming Pinned's count, and opens a project's Resolved from its door", () => {
  const toggled = vi.fn();
  const pinned = render(<SectionToggle section={{ kind: "section", key: "pinned:threads", part: "pinned", label: "Pinned", count: 2, open: true }} motion={{}} onToggle={toggled} />);
  const button = pinned.getByRole("button", { name: "Pinned, 2" });
  expect(button.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(button);
  expect(toggled).toHaveBeenCalledOnce();
  cleanup();
  const resolved = render(<ResolvedDoor open={false} motion={{}} onToggle={toggled} />);
  const door = resolved.getByRole("button", { name: "Resolved" });
  expect(door.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(door);
  expect(toggled).toHaveBeenCalledTimes(2);
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

it("dims a cloud group's cloud while OpenOrc Cloud is out of reach, as its rows, which leave the cloud to it, cannot", () => {
  const faded = (view: ReturnType<typeof render>) => Array.from(view.container.querySelectorAll("div")).some((element) => /opacity-40/.test(String(nativeProps.get(element)?.className)));
  const group = { kind: "project" as const, key: "project:p", project: { id: "p", name: "notes-app", cloud: true as const }, open: true, waiting: 0 };
  expect(faded(render(<ProjectLabel group={group} motion={{}} onToggle={() => undefined} />))).toBe(false);
  cleanup();
  expect(faded(render(<ProjectLabel group={{ ...group, offline: true }} motion={{}} onToggle={() => undefined} />))).toBe(true);
  cleanup();
  const out = render(
    <CloudOutOfReach.Provider value>
      <ProjectLabel group={group} motion={{}} onToggle={() => undefined} />
    </CloudOutOfReach.Provider>,
  );
  expect(faded(out)).toBe(true);
  cleanup();
  // A folder never fades.
  expect(faded(render(<ProjectLabel group={{ ...group, project: { id: "p", name: "openorc" } }} motion={{}} onToggle={() => undefined} />))).toBe(false);
});
