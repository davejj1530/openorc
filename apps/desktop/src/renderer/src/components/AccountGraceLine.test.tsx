import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AccountGraceLine } from "./AccountGraceLine";

afterEach(cleanup);

it("keeps the full local deadline on demand and both responsive word lengths available", () => {
  const until = new Date(2026, 10, 15, 14, 5).getTime();
  const { container } = render(<AccountGraceLine until={until} now={new Date(2026, 10, 14, 14, 5).getTime()} />);
  expect(screen.getByText(/Pro ends tomorrow at/)).toBeTruthy();
  expect(screen.getByText(/Pro ends (Nov 15|15 Nov)/)).toBeTruthy();
  expect(container.querySelector("[data-tip]")?.getAttribute("data-tip")).toContain("2026");
  expect(container.querySelector("[title]")).toBeNull();
});
