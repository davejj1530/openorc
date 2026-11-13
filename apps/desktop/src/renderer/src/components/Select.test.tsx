import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { Select } from "./ui";

// Windows and Linux, where the list is drawn in the page. The stylesheet keys on the same mark.
beforeEach(() => {
  document.documentElement.dataset.platform = "linux";
});
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.platform;
});

const sizerLabels = (container: HTMLElement) => [...container.querySelectorAll('.select-value > [aria-hidden="true"]')].map((span) => span.textContent);

it("shows the chosen option over every option's text, groups, fragments and nested text included", () => {
  const { container } = render(
    <Select defaultValue="count">
      <option value="count">
        {"Count "}
        {3}
      </option>
      <optgroup label="Group">
        <option value="grouped">Grouped</option>
      </optgroup>
      <>
        <option value="fragment">Fragment</option>
      </>
      <option value="nested">
        <span>Nested</span> text
      </option>
    </Select>,
  );
  expect(container.querySelector(".select-value > selectedcontent")).not.toBeNull();
  expect(sizerLabels(container)).toEqual(["Count 3", "Grouped", "Fragment", "Nested text"]);
});

it("counts the options a component draws, and follows them when they change on their own", async () => {
  let add = () => {};
  function Agents() {
    const [names, setNames] = useState(["Claude"]);
    add = () => setNames((current) => [...current, "A much longer agent name"]);
    return names.map((name) => <option key={name}>{name}</option>);
  }
  const { container } = render(
    <Select>
      <Agents />
    </Select>,
  );
  expect(sizerLabels(container)).toEqual(["Claude"]);
  act(() => add());
  await waitFor(() => expect(sizerLabels(container)).toEqual(["Claude", "A much longer agent name"]));
});

it("shows the chosen option's new text in the closed select when that text changes in place", async () => {
  const change = vi.fn();
  const options = (label: string) => (
    <Select value="" onChange={change}>
      <option value="">{label}</option>
      <option value="other">Other</option>
    </Select>
  );
  const { container, rerender } = render(options("Default (Old model)"));
  const select = container.querySelector("select")!;
  const closed = container.querySelector("selectedcontent")!;
  expect(closed.textContent).toBe("Default (Old model)");
  rerender(options("Default (New model)"));
  await waitFor(() => expect(closed.textContent).toBe("Default (New model)"));
  expect(select.value).toBe("");
  expect(change).not.toHaveBeenCalled();
});

it("leaves every choice of a select that takes several alone", async () => {
  const options = (label: string) => (
    <Select multiple defaultValue={["one", "two"]}>
      <option value="one">{label}</option>
      <option value="two">Two</option>
    </Select>
  );
  const { container, rerender } = render(options("One"));
  rerender(options("One, renamed"));
  await waitFor(() => expect(sizerLabels(container)).toEqual(["One, renamed", "Two"]));
  expect([...container.querySelector("select")!.selectedOptions].map((option) => option.value)).toEqual(["one", "two"]);
});

it("takes focus to the row under a pointer that moved, so the row Enter picks is the one marked", () => {
  const own = vi.fn();
  const { container } = render(
    <Select onPointerMove={own}>
      <option>One</option>
      <option>Two</option>
      <option disabled>Off</option>
    </Select>,
  );
  const [, two, off] = [...container.querySelectorAll("option")];
  const focused = [two!, off!].map((option) => vi.spyOn(option, "focus"));
  fireEvent.pointerMove(two!, { clientX: 20, clientY: 40 });
  expect(focused[0]).toHaveBeenCalledTimes(1);
  // The same spot again is the list scrolling under a pointer at rest: the keyboard's row keeps focus.
  fireEvent.pointerMove(two!, { clientX: 20, clientY: 40 });
  expect(focused[0]).toHaveBeenCalledTimes(1);
  fireEvent.pointerMove(off!, { clientX: 20, clientY: 60 });
  expect(focused[1]).not.toHaveBeenCalled();
  expect(own).toHaveBeenCalledTimes(3);
});

it("renders the select alone where the OS draws the list itself", () => {
  document.documentElement.dataset.platform = "darwin";
  const { container, getByText } = render(
    <Select defaultValue="one">
      <option value="one">One</option>
      <option value="two">Two</option>
    </Select>,
  );
  expect([...container.querySelector("select")!.children].map((child) => child.tagName)).toEqual(["OPTION", "OPTION"]);
  expect(getByText("One").tagName).toBe("OPTION");
  const two = container.querySelectorAll("option")[1]!;
  const focus = vi.spyOn(two, "focus");
  fireEvent.pointerMove(two, { clientX: 5, clientY: 5 });
  expect(focus).not.toHaveBeenCalled();
});

it("keeps Escape from an open list away from what holds the select, and lets it rise once the list is closed", () => {
  const own = vi.fn();
  const holder = vi.fn();
  const page = vi.fn();
  document.addEventListener("keydown", page);
  onTestFinished(() => document.removeEventListener("keydown", page));
  const { container } = render(
    <div onKeyDown={holder}>
      <Select onKeyDown={own}>
        <option>One</option>
      </Select>
    </div>,
  );
  const select = container.querySelector("select")!;
  const open = vi.spyOn(select, "matches").mockImplementation((selector) => selector === ":open");
  fireEvent.keyDown(select, { key: "Escape" });
  expect(own).toHaveBeenCalledTimes(1);
  expect(holder).not.toHaveBeenCalled();
  expect(page).not.toHaveBeenCalled();

  open.mockRestore();
  fireEvent.keyDown(select, { key: "Escape" });
  expect(own).toHaveBeenCalledTimes(2);
  expect(holder).toHaveBeenCalledTimes(1);
  expect(page).toHaveBeenCalledTimes(1);
});
