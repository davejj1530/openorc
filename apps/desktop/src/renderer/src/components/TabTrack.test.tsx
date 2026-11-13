import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { TabTrack } from "./TabTrack";

afterEach(cleanup);

function Tabs() {
  const [value, setValue] = useState("overview");
  return (
    <TabTrack
      label="Sections"
      panelId="content"
      value={value}
      onSelect={setValue}
      items={[
        { id: "overview", label: "Overview" },
        { id: "activity", label: "Activity" },
        { id: "memory", label: "Memory" },
      ]}
    />
  );
}

it("uses one tab stop and moves selection and focus with arrows, Home, and End", () => {
  render(<Tabs />);
  const overview = screen.getByRole("tab", { name: "Overview" });
  const activity = screen.getByRole("tab", { name: "Activity" });
  const memory = screen.getByRole("tab", { name: "Memory" });
  expect(overview.tabIndex).toBe(0);
  expect(activity.tabIndex).toBe(-1);
  expect(overview.getAttribute("aria-controls")).toBe("content");
  for (const [from, key, to] of [
    [overview, "ArrowRight", activity],
    [activity, "End", memory],
    [memory, "ArrowRight", overview],
    [overview, "ArrowLeft", memory],
    [memory, "Home", overview],
  ] as const) {
    fireEvent.keyDown(from, { key });
    expect(document.activeElement).toBe(to);
    expect(to.getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("tab").filter((tab) => tab.tabIndex === 0)).toEqual([to]);
  }
});
