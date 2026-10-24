import { afterEach, expect, it } from "vitest";
import { keyboard } from "../test-fixtures/react-native";
import { opened } from "../test-fixtures/web-browser";
import { openInApp } from "./web";

afterEach(() => void (opened.length = 0));

it("puts the keyboard away as a page opens in Safari over the app, as it would cover the sheet's foot", () => {
  keyboard.up = true;
  openInApp("https://github.com/me/openorc/pull/471");
  expect(keyboard.up).toBe(false);
  expect(opened).toEqual(["https://github.com/me/openorc/pull/471"]);
});
