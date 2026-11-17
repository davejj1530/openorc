import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render as mount, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it } from "vitest";
import { queryClient } from "../lib/client";
import { ContextUsage } from "./ContextUsage";

/** As the app mounts it: Compact reads whether its conversation's place may run it. */
const render = (node: ReactNode) => mount(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);

afterEach(cleanup);

it("opens into the amount, what is used and what is left, and the one action, with no paragraphs", async () => {
  render(<ContextUsage used={36000} window={200000} onCompact={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Context usage" }));
  const card = await screen.findByRole("dialog");
  expect(card.querySelector(".composer-context-amount")?.textContent).toBe("36k of 200k");
  expect([...card.querySelectorAll("dt")].map((term) => `${term.textContent} ${term.nextElementSibling?.textContent}`)).toEqual(["Used 36,000 tokens", "Available 164,000 tokens"]);
  expect(card.querySelector("p")).toBeNull();
  expect(screen.getByRole("button", { name: "Compact context" })).toHaveProperty("disabled", false);
});

it("keeps Compact dimmed with its reason on demand while it cannot run", async () => {
  render(<ContextUsage used={36000} window={200000} disabledReason="Available after this turn finishes." />);
  fireEvent.click(screen.getByRole("button", { name: "Context usage" }));
  const compact = await screen.findByRole("button", { name: "Compact context" });
  expect(compact).toHaveProperty("disabled", true);
  expect(compact.getAttribute("data-tip")).toBe("Available after this turn finishes.");
});

it("draws the share beside send as a filled share, never an arc a loader could be", () => {
  render(<ContextUsage used={150000} window={200000} />);
  const trigger = screen.getByRole("button", { name: "Context usage" });
  expect(trigger.getAttribute("data-tone")).toBe("warn");
  expect(trigger.querySelector("svg circle[stroke]")).toBeNull();
  expect(trigger.querySelector("svg path")?.getAttribute("fill")).toBe("currentColor");
});
