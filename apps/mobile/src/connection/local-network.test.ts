import { getIpAddressAsync } from "expo-network";
import { afterAll, expect, it, vi } from "vitest";
import { primeLocalNetwork } from "./local-network";

vi.mock("expo-network", () => ({ getIpAddressAsync: vi.fn() }));
const dialed: string[] = [];
vi.stubGlobal(
  "WebSocket",
  class {
    constructor(url: string) {
      dialed.push(url);
    }
    close() {}
  },
);
afterAll(() => vi.unstubAllGlobals());

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("waits for a Wi-Fi network when Pair first opens off one, then raises the prompt there once", async () => {
  vi.mocked(getIpAddressAsync).mockResolvedValue("100.72.14.3");
  primeLocalNetwork();
  await settle();
  expect(dialed).toEqual([]);
  vi.mocked(getIpAddressAsync).mockResolvedValue("192.168.1.23");
  primeLocalNetwork();
  await settle();
  primeLocalNetwork();
  await settle();
  expect(dialed).toEqual(["ws://192.168.1.1:9/"]);
});
