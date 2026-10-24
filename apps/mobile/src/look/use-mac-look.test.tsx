// @vitest-environment jsdom
import type { AppLook } from "@openorc/protocol";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { LinkState } from "../connection/manager";
import { palettes, stylesheet } from "../generated/palettes";
import { colors as defaults } from "../generated/tokens";
import { keepLists, restoreLists } from "../lists-cache";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { useColors } from "../ui/mode";
import { applyLook, followMacLook } from "./look";
import { paintPalette } from "./paint";
import { useMacLook } from "./use-mac-look";

const studio = { id: "studio", name: "Studio" };
const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, look: null as AppLook | null, state: null as unknown as LinkState, reads: 0 }));

vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac(async (method) => {
    if (method !== "app.settings.get") throw new Error(`no ${method}`);
    mac.reads++;
    return { defaultHarness: null, look: mac.look };
  });
  return { ...mac.phone.module, useLinkState: () => mac.state };
});

beforeAll(() => void followMacLook(mac.phone!.module.queryClient.getQueryCache()));
beforeEach(() => {
  mac.state = { kind: "connected", mac: studio, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };
  mac.look = null;
  mac.reads = 0;
});
afterEach(() => {
  cleanup();
  mac.phone!.module.queryClient.clear();
  applyLook(null);
});

const open = () => renderHook(() => ({ palette: useMacLook(), colors: useColors() }), { wrapper: mac.phone!.wrapper });

it("paints the Mac's palette, and a palette changed on the Mac as soon as it says so", async () => {
  mac.look = { palette: "linear", colors: {} };
  const phone = open();
  await waitFor(() => expect(phone.result.current.palette).toBe("linear"));
  expect(phone.result.current.colors.bg).toBe(paintPalette(palettes.linear.light, stylesheet.light).bg);
  const ground = defaults.light["ok-soft"];
  mac.look = { palette: "linear", colors: { light: { "--bg": ground } } };
  mac.phone!.module.client.invalidateTags(["settings"]);
  await waitFor(() => expect(phone.result.current.colors.bg).toBe(ground));
  mac.look = { palette: "claude", colors: {} };
  mac.phone!.module.client.invalidateTags(["settings"]);
  await waitFor(() => expect(phone.result.current.palette).toBe("claude"));
});

it("keeps the Mac's look for the next launch, which paints it before the Mac answers", async () => {
  const { queryClient, storage } = mac.phone!.module;
  const stop = keepLists(queryClient, storage, () => "studio");
  mac.look = { palette: "github", colors: {} };
  const first = open();
  await waitFor(() => expect(mac.phone!.saved.get("lists.studio")).toContain("github"), { timeout: 2_000 });
  first.unmount();
  stop();
  queryClient.clear();
  expect(open().result.current.palette).toBe("openorc");
  mac.state = { kind: "connecting", mac: studio, why: null };
  mac.look = null;
  restoreLists(queryClient, storage, "studio");
  expect(open().result.current.palette).toBe("github");
});
