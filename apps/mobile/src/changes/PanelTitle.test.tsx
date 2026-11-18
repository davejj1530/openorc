// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LinkState } from "../connection/manager";
import { PanelTitle } from "./PanelTitle";

const studio = { id: "mac-1", name: "Studio" };
const asleep: LinkState = { kind: "waiting", mac: studio, why: "silent", retryAt: null };
const phone = vi.hoisted(() => ({ link: null as unknown, own: false }));
vi.mock("../client", () => ({ useLinkState: () => phone.link }));
vi.mock("../cloud/use-own-cloud", () => ({ useOwnCloud: () => phone.own }));

afterEach(() => {
  cleanup();
  phone.own = false;
});

it("gives the line to the Mac's link while it is out of reach", () => {
  phone.link = asleep;
  render(<PanelTitle title="launch" line="Saved 4m ago" />);
  expect(screen.queryByText("Saved 4m ago")).toBeNull();
});

it("keeps the line of a panel that reads OpenOrc Cloud through the phone's own session", () => {
  phone.link = asleep;
  phone.own = true;
  render(<PanelTitle title="launch" line="Saved 4m ago" fromCloud />);
  expect(screen.getByText("Saved 4m ago")).toBeTruthy();
});

it("gives the line to the Mac's link for a cloud panel the phone reads through the Mac", () => {
  phone.link = asleep;
  render(<PanelTitle title="launch" line="Saved 4m ago" fromCloud />);
  expect(screen.queryByText("Saved 4m ago")).toBeNull();
});
