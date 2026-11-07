// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import * as ImagePicker from "expo-image-picker";
import type { ReactNode } from "react";
import { ActionSheetIOS } from "react-native";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LinkState } from "../connection/manager";
import { HostContext } from "../connection/host-context";
import { useImageAttach } from "./use-image-attach";

/** The link state shown, and each host's answer to saving an image: the cloud brain is the partner host. */
const phone = vi.hoisted(() => ({ state: null as LinkState | null, macSave: vi.fn(), brainSave: vi.fn() }));
vi.mock("../client", () => ({
  useLinkState: () => phone.state,
  hostLink: (host: string | null) => ({ connection: { call: host === "brain" ? phone.brainSave : phone.macSave } }),
}));
vi.mock("expo-image-manipulator", () => ({
  ImageManipulator: { manipulate: () => ({ resize: () => undefined, renderAsync: async () => ({ saveAsync: async () => ({ uri: "file:///small.jpg", base64: "AAAA" }) }) }) },
  SaveFormat: { JPEG: "jpeg" },
}));
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

it("saves a photo for a cloud thread on the brain that holds it, which names the path the message carries", async () => {
  phone.state = studio;
  phone.brainSave.mockResolvedValue({ path: "/vercel/sandbox/openorc-brain/data/attachments/photo.jpg" });
  vi.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValueOnce({ canceled: false, assets: [{ uri: "file:///photo.heic", width: 100, height: 80, fileName: "photo.heic" }] } as never);
  vi.mocked(ActionSheetIOS.showActionSheetWithOptions).mockImplementation((options, choose) => choose(options.options.indexOf("Photo Library")));
  const images: unknown[] = [];
  const wrapper = ({ children }: { children: ReactNode }) => <HostContext.Provider value="brain">{children}</HostContext.Provider>;
  const { result } = renderHook(() => useImageAttach({ onImage: (image) => images.push(image), onError: () => undefined }), { wrapper });
  act(() => result.current.chooseImages());
  await waitFor(() => expect(images).toEqual([{ path: "/vercel/sandbox/openorc-brain/data/attachments/photo.jpg", preview: "file:///small.jpg" }]));
  expect(phone.brainSave).toHaveBeenCalledWith("attachments.save", { name: "photo.jpg", mime: "image/jpeg", dataBase64: "AAAA" });
  expect(phone.macSave).not.toHaveBeenCalled();
});
