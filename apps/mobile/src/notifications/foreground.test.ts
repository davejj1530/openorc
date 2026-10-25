import { expect, it } from "vitest";
import type { LinkState } from "../connection/manager";
import { clearDelivered, presentationFor } from "./foreground";

const studio = { id: "studio", name: "Studio" };
const connected: LinkState = { kind: "connected", mac: studio, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };
const route = { macId: "studio", id: "n1", kind: "finished", threadId: "t1" };
const shown = { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false };
const hidden = { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false };

it.each([
  { name: "the thread is on screen, live from that Mac", data: route, link: connected, onScreen: "t1", want: hidden },
  { name: "Home is on screen", data: route, link: connected, onScreen: null, want: shown },
  { name: "another thread is on screen", data: route, link: connected, onScreen: "t2", want: shown },
  { name: "the screen may be stale while not connected", data: route, link: { kind: "waiting", mac: studio, why: "unreachable", retryAt: null }, onScreen: "t1", want: shown },
  { name: "the phone shows another Mac", data: { ...route, macId: "laptop" }, link: connected, onScreen: "t1", want: shown },
  { name: "the extension could not open it", data: {}, link: connected, onScreen: "t1", want: shown },
] as const)("shows an alert in the app unless $name", ({ data, link, onScreen, want }) => {
  expect(presentationFor(data, link, onScreen)).toEqual(want);
});

it("clears only that Mac's delivered alerts for the thread just opened", async () => {
  const delivered = [
    { id: "a", data: route },
    { id: "b", data: { ...route, id: "n2", threadId: "t2" } },
    { id: "c", data: { ...route, macId: "laptop" } },
    { id: "d", data: {} },
    { id: "e", data: { ...route, id: "n3" } },
  ];
  const dismissed: string[] = [];
  await clearDelivered("studio", "t1", { delivered: async () => delivered, dismiss: async (id) => void dismissed.push(id) });
  expect(dismissed).toEqual(["a", "e"]);
});
