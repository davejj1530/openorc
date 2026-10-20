import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Chip, CountBadge, StatusDot } from "./ui";

afterEach(cleanup);

function Toggle() {
  const [pressed, setPressed] = useState(false);
  return (
    <Chip pressed={pressed} count={2} onClick={() => setPressed((value) => !value)}>
      Running
    </Chip>
  );
}

it("toggles aria-pressed and keeps its count in the name", () => {
  render(<Toggle />);
  const chip = screen.getByRole("button", { name: "Running 2" });
  expect(chip.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(chip);
  expect(chip.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(chip);
  expect(chip.getAttribute("aria-pressed")).toBe("false");
});

it("leaves the count out when there is none", () => {
  render(
    <Chip pressed={false} onClick={() => {}}>
      All
    </Chip>,
  );
  expect(screen.getByRole("button", { name: "All" })).toBeTruthy();
});

it("rolls a count to its new value and reads only the new one", () => {
  const { rerender, container } = render(<CountBadge count={2} />);
  const badge = container.firstElementChild as HTMLElement;
  expect(badge.textContent).toBe("2");
  expect(badge.querySelector(".count-badge-in")).toBeNull();

  act(() => rerender(<CountBadge count={3} />));
  expect(badge.dataset.roll).toBe("up");
  expect(badge.querySelector(".count-badge-in")?.textContent).toBe("3");
  expect(badge.querySelector(".count-badge-out")?.getAttribute("aria-hidden")).toBe("true");

  act(() => rerender(<CountBadge count={1} />));
  expect(badge.dataset.roll).toBe("down");
  expect(badge.querySelector(".count-badge-in")?.textContent).toBe("1");
  expect(badge.querySelector(".count-badge-out")?.textContent).toBe("3");
});

it("caps a count past its max", () => {
  const { container } = render(<CountBadge count={140} />);
  expect(container.textContent).toBe("99+");
});

it("names a status dot only when it carries a label", () => {
  const { container } = render(
    <>
      <StatusDot tone="attention" label="Needs you" />
      <StatusDot tone="ok" />
    </>,
  );
  expect(screen.getByRole("img", { name: "Needs you" })).toBeTruthy();
  expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
});
