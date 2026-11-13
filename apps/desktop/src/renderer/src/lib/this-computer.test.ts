import { afterEach, expect, it, vi } from "vitest";

async function on(platform: string) {
  vi.resetModules();
  vi.stubGlobal("openorc", { platform });
  return import("./this-computer");
}

afterEach(() => vi.unstubAllGlobals());

it("names the machine by its platform, so Linux and Windows never read Mac", async () => {
  const words = async (platform: string) => {
    const { ThisComputer, thisComputer, machine, revealLabel } = await on(platform);
    return [ThisComputer, thisComputer, machine, revealLabel()];
  };
  expect(await words("darwin")).toEqual(["This Mac", "this Mac", "Mac", "Show in Finder"]);
  expect(await words("win32")).toEqual(["This PC", "this PC", "PC", "Show in Explorer"]);
  expect(await words("linux")).toEqual(["This computer", "this computer", "this computer", "Show in folder"]);
});
