import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRouter } from "../lib/router";
import { CLOUD_RELEASE, readWhatsNewSeen, useWhatsNew } from "../lib/whats-new";
import { WhatsNew } from "./WhatsNew";

const account = vi.hoisted(() => ({ state: "signed-in" as string }));
vi.mock("../lib/client", () => ({ useRpc: () => ({ data: { state: account.state } }) }));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));

const finishedOnboarding = () => localStorage.setItem("openorc.onboarding", JSON.stringify({ version: 1, step: "done", completedAt: 1, selectedHarnesses: ["claude"], defaultHarness: "claude" }));

beforeEach(() => {
  localStorage.clear();
  account.state = "signed-in";
  useWhatsNew.setState({ due: null });
});
afterEach(cleanup);

it("opens after the update for a profile that used an earlier version, and closing it is kept", () => {
  finishedOnboarding();
  useWhatsNew.getState().settle(CLOUD_RELEASE);
  render(<WhatsNew />);
  expect(screen.getByRole("dialog", { name: "Threads that keep working with your Mac closed" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(useWhatsNew.getState().due).toBeNull();
  expect(readWhatsNewSeen()).toBe(CLOUD_RELEASE);
  useWhatsNew.getState().settle(CLOUD_RELEASE);
  expect(useWhatsNew.getState().due).toBeNull();
});

it("never opens for a fresh install, whose onboarding comes first", () => {
  useWhatsNew.getState().settle(CLOUD_RELEASE);
  render(<WhatsNew />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(readWhatsNewSeen()).toBe(CLOUD_RELEASE);
  finishedOnboarding();
  useWhatsNew.getState().settle(CLOUD_RELEASE);
  expect(useWhatsNew.getState().due).toBeNull();
});

it("waits for a dialog the person is in to close before it opens", async () => {
  finishedOnboarding();
  const other = document.createElement("div");
  other.setAttribute("role", "dialog");
  document.body.append(other);
  useWhatsNew.getState().settle(CLOUD_RELEASE);
  render(<WhatsNew />);
  expect(screen.queryByRole("dialog", { name: "Threads that keep working with your Mac closed" })).toBeNull();
  act(() => other.remove());
  expect(await screen.findByRole("dialog", { name: "Threads that keep working with your Mac closed" })).toBeTruthy();
});

it("goes through each step with Next and closes for good with Done", () => {
  finishedOnboarding();
  useWhatsNew.getState().settle(CLOUD_RELEASE);
  render(<WhatsNew />);
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("dialog", { name: "Work with your team" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Your cloud threads on your phone" }));
  expect(screen.getByRole("dialog", { name: "Your cloud threads on your phone" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(readWhatsNewSeen()).toBe(CLOUD_RELEASE);
});

it("offers sign in first, and trying a step closes the steps for good", () => {
  account.state = "signed-out";
  finishedOnboarding();
  useWhatsNew.getState().settle(CLOUD_RELEASE);
  render(<WhatsNew />);
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(useRouter.getState().route).toEqual({ view: "settings", section: "account" });
  expect(readWhatsNewSeen()).toBe(CLOUD_RELEASE);
});

it("takes a signed-in person to the step's own place", () => {
  finishedOnboarding();
  useWhatsNew.getState().settle(CLOUD_RELEASE);
  render(<WhatsNew />);
  fireEvent.click(screen.getByRole("button", { name: "Open Cloud settings" }));
  expect(useRouter.getState().route).toEqual({ view: "settings", section: "cloud" });
});
