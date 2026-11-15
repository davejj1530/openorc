// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FakeLink } from "../test-fixtures/fake-link";
import { keyboard, nativeProps } from "../test-fixtures/react-native";
import { ImageTile } from "./images";

/** The link, and the phone's cache of the Mac's images. */
const tile = vi.hoisted(() => ({ link: null as FakeLink | null, uri: vi.fn() }));

vi.mock("../client", async () => {
  const { fakeLink } = await import("../test-fixtures/fake-link");
  tile.link = fakeLink();
  return { useLinkRead: tile.link.useLinkRead, assetUri: tile.uri };
});

afterEach(cleanup);

it("loads an image again once the link is back, after the link dropped it", async () => {
  const answers: { resolve: (uri: string) => void; reject: (error: Error) => void }[] = [];
  tile.uri.mockImplementation(() => new Promise((resolve, reject) => answers.push({ resolve, reject })));
  render(<ImageTile asset={{ kind: "attachment", name: "shot.png" }} label="Attached image" compact />);
  await act(async () => answers[0]!.reject(new Error("The connection to your Mac dropped before it answered.")));
  expect(screen.getByText("Image unavailable")).toBeTruthy();

  act(() => tile.link!.to(null));
  expect(tile.uri).toHaveBeenCalledTimes(1);
  act(() => tile.link!.to(2));
  expect(tile.uri).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("Image unavailable")).toBeNull();
  await act(async () => answers[1]!.resolve("file:///cache/shot.png"));
  const image = screen.getByLabelText("Attached image").querySelector("img")!;
  expect(nativeProps.get(image)?.source).toEqual({ uri: "file:///cache/shot.png" });
  expect(tile.uri).toHaveBeenLastCalledWith({ kind: "attachment", name: "shot.png" });
});

it("puts the keyboard away as an image opens full screen", async () => {
  tile.uri.mockResolvedValue("file:///cache/shot.png");
  render(<ImageTile asset={{ kind: "attachment", name: "shot.png" }} label="Attached image" compact />);
  await act(async () => undefined);
  keyboard.up = true;
  act(() => screen.getByRole("imagebutton", { name: "Attached image" }).click());
  expect(keyboard.up).toBe(false);
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
});
