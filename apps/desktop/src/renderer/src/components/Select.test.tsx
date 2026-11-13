import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { Select } from "./ui";

afterEach(cleanup);

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

it("has the closed select copy its chosen option again when that option's text changes in place", async () => {
  const change = vi.fn();
  const options = (label: string) => (
    <Select value="" onChange={change}>
      <option value="">{label}</option>
      <option value="other">Other</option>
    </Select>
  );
  const { container, rerender } = render(options("Default (Old model)"));
  const select = container.querySelector("select")!;
  const chosen = vi.spyOn(HTMLSelectElement.prototype, "selectedIndex", "set");
  rerender(options("Default (New model)"));
  await waitFor(() => expect(chosen).toHaveBeenCalledWith(0));
  chosen.mockRestore();
  expect(select.value).toBe("");
  expect(change).not.toHaveBeenCalled();
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
