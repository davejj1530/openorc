import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Segmented } from "./Segmented";

afterEach(cleanup);

const options = [
  { value: "list", label: "List" },
  { value: "board", label: "Board" },
  { value: "archive", label: "Archive", disabled: true, reason: "Nothing archived yet" },
] as const;

type View = (typeof options)[number]["value"];

function Harness({ onChange }: { onChange?: (value: View) => void }) {
  const [value, setValue] = useState<View>("list");
  return (
    <Segmented
      label="View"
      value={value}
      options={options}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

it("is a radiogroup whose checked radio follows the choice", () => {
  render(<Harness />);
  const group = screen.getByRole("radiogroup", { name: "View" });
  expect(within(group).getByRole("radio", { name: "List" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(within(group).getByRole("radio", { name: "Board" }));
  expect(within(group).getByRole("radio", { name: "Board" }).getAttribute("aria-checked")).toBe("true");
  expect(within(group).getByRole("radio", { name: "List" }).getAttribute("aria-checked")).toBe("false");
});

it("keeps a disabled choice out of reach and says why on hover", () => {
  const onChange = vi.fn();
  render(<Harness onChange={onChange} />);
  const archive = screen.getByRole("radio", { name: "Archive" });
  expect(archive).toHaveProperty("disabled", true);
  expect(archive.getAttribute("title")).toBe("Nothing archived yet");
  fireEvent.click(archive);
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole("radio", { name: "Board" }).hasAttribute("title")).toBe(false);
});

it("draws the knob for screens only, under the chosen radio", () => {
  render(<Harness />);
  const group = screen.getByRole("radiogroup", { name: "View" });
  const knob = group.querySelector(".segmented-knob");
  expect(knob?.getAttribute("aria-hidden")).toBe("true");
  expect(within(group).getAllByRole("radio")).toHaveLength(3);
});
