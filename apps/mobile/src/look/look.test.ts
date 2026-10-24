import type { AppSettings } from "@openorc/protocol";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it } from "vitest";
import { palettes, stylesheet } from "../generated/palettes";
import { colors } from "../generated/tokens";
import { variables } from "../test-fixtures/uniwind";
import { applyLook, currentLook, followMacLook } from "./look";
import { paintPalette } from "./paint";

afterEach(() => applyLook(null));

const linear = { light: paintPalette(palettes.linear.light, stylesheet.light), dark: paintPalette(palettes.linear.dark, stylesheet.dark) };

it("paints a Mac's palette and colors in both modes, through every class and useColors, and the default once it has none", () => {
  // Any hex will do as the person's own accent; the default's ok green is one.
  const accent = colors.dark.ok;
  applyLook({ palette: "linear", colors: { dark: { "--accent": accent } } });
  expect(currentLook().preset).toBe("linear");
  expect(currentLook().colors.light).toEqual(linear.light);
  expect(currentLook().colors.dark).toMatchObject({ accent, bg: linear.dark.bg, ink: linear.dark.ink });
  expect(currentLook().colors.dark["accent-ink"]).not.toBe(linear.dark["accent-ink"]);
  expect(variables["light"]).toMatchObject({ "--color-bg": linear.light.bg, "--color-accent": linear.light.accent });
  expect(variables["dark"]).toMatchObject({ "--color-accent": accent });
  applyLook(null);
  expect(currentLook()).toEqual({ preset: "openorc", colors });
  expect(variables["light"]).toMatchObject({ "--color-bg": colors.light.bg, "--color-accent": colors.light.accent });
});

it("paints the default for a palette this phone does not have", () => {
  applyLook({ palette: "aurora", colors: { light: { "--accent": colors.light.ok } } });
  expect(currentLook()).toEqual({ preset: "openorc", colors });
});

it("follows the shown Mac's settings in the query cache: kept, answered, and gone when the phone shows another Mac", () => {
  const queries = new QueryClient();
  const stop = followMacLook(queries.getQueryCache());
  const settings = (palette: string) => ({ defaultHarness: null, look: { palette, colors: {} } }) as unknown as AppSettings;
  queries.setQueryData(["app.settings.get", {}], settings("claude"));
  expect(currentLook().preset).toBe("claude");
  queries.setQueryData(["app.settings.get", {}], settings("github"));
  expect(currentLook().preset).toBe("github");
  queries.setQueryData(["projects.list", {}], []);
  expect(currentLook().preset).toBe("github");
  queries.clear();
  expect(currentLook().preset).toBe("openorc");
  stop();
});
