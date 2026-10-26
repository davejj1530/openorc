// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import * as ImagePicker from "expo-image-picker";
import { ActionSheetIOS } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LinkState } from "../connection/manager";
import { useImageAttach } from "./use-image-attach";

const phone = vi.hoisted(() => ({ state: null as LinkState | null }));
vi.mock("../client", () => ({ useLinkState: () => phone.state, link: { connection: { call: vi.fn() } } }));
vi.mock("expo-image-manipulator", () => ({ ImageManipulator: {}, SaveFormat: {} }));
vi.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: vi.fn(async () => ({ granted: false })),
  launchCameraAsync: vi.fn(async () => ({ canceled: true })),
  launchImageLibraryAsync: vi.fn(async () => ({ canceled: true })),
}));

const studio: LinkState = { kind: "connected", mac: { id: "studio", name: "Studio" }, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };
const demo: LinkState = { kind: "connected", mac: { id: "demo", name: "Demo Mac" }, route: { kind: "demo" }, serial: 1 };

/** What each action sheet offered. The person takes a photo whenever one offers to. */
const offered: string[][] = [];
beforeEach(() => {
  vi.clearAllMocks();
  offered.length = 0;
  vi.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation((options, choose) => {
    offered.push(options.options);
    choose(options.options.indexOf("Take Photo"));
  });
});
afterEach(cleanup);

function attachWith(state: LinkState) {
  phone.state = state;
  const { result } = renderHook(() => useImageAttach({ onImage: () => undefined, onError: () => undefined }));
  act(() => result.current.chooseImages());
}

it("offers a Mac's draft the library or the camera, and asks iOS for the camera once it is chosen", async () => {
  attachWith(studio);
  expect(offered).toEqual([["Photo Library", "Take Photo", "Cancel"]]);
  await waitFor(() => expect(ImagePicker.requestCameraPermissionsAsync).toHaveBeenCalledOnce());
});

it("opens the library at once in the demo, and never asks iOS for the camera", async () => {
  attachWith(demo);
  await waitFor(() => expect(ImagePicker.launchImageLibraryAsync).toHaveBeenCalledOnce());
  expect(offered).toEqual([]);
  expect(ImagePicker.requestCameraPermissionsAsync).not.toHaveBeenCalled();
});
