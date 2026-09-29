import assert from "node:assert/strict";
import { test } from "node:test";
import { detectDownloadDevice, downloadDevice, type DownloadNavigator } from "./download-platform";

const mac: DownloadNavigator = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 0 };
const windows: DownloadNavigator = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", platform: "Win32", maxTouchPoints: 0 };

void test("never assumes that a MacIntel user agent means an Intel chip", () => {
  assert.deepEqual(downloadDevice(mac), { platform: "mac", target: null });
  assert.equal(downloadDevice(mac, { architecture: "arm", bitness: "64" }).target, "mac-arm64");
  assert.equal(downloadDevice(mac, { architecture: "x86", bitness: "64" }).target, "mac-x64");
});

void test("suggests Windows x64 without claiming support for ARM or 32-bit systems", () => {
  assert.equal(downloadDevice(windows).target, "win-x64");
  assert.equal(downloadDevice(windows, { architecture: "arm", bitness: "64" }).target, null);
  assert.equal(downloadDevice(windows, { architecture: "x86", bitness: "32" }).target, null);
  assert.equal(downloadDevice({ ...windows, userAgent: "Windows NT 10.0; ARM64" }).target, null);
});

void test("recognizes iPad desktop mode and does not offer desktop builds on phones or ChromeOS", () => {
  assert.deepEqual(downloadDevice({ ...mac, maxTouchPoints: 5 }), { platform: "mobile", target: null });
  for (const userAgent of ["iPhone", "iPad", "Linux; Android 14"]) assert.equal(downloadDevice({ ...mac, userAgent }).platform, "mobile");
  assert.deepEqual(downloadDevice({ userAgent: "X11; CrOS x86_64 14541.0.0", platform: "Linux x86_64", maxTouchPoints: 0 }), { platform: "other", target: null });
});

void test("suggests a Linux package only when the browser names its distribution and runs on x64", () => {
  const linux = (userAgent: string): DownloadNavigator => ({ userAgent, platform: "Linux x86_64", maxTouchPoints: 0 });
  assert.deepEqual(downloadDevice(linux("Mozilla/5.0 (X11; Linux x86_64)")), { platform: "linux", target: null });
  assert.equal(downloadDevice(linux("Mozilla/5.0 (X11; Fedora; Linux x86_64; rv:130.0)")).target, "linux-rpm");
  assert.equal(downloadDevice(linux("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0)")).target, "linux-deb");
  assert.equal(downloadDevice({ ...linux("Mozilla/5.0 (X11; Fedora; Linux aarch64; rv:130.0)"), platform: "Linux aarch64" }).target, null);
  assert.equal(downloadDevice(linux("Mozilla/5.0 (X11; Fedora; Linux x86_64; rv:130.0)"), { architecture: "arm", bitness: "64" }).target, null);
});

void test("uses browser hints and gracefully handles denied or withheld architecture", async () => {
  assert.equal((await detectDownloadDevice({ ...mac, userAgentData: { platform: "macOS", getHighEntropyValues: async () => ({ architecture: "arm", bitness: "64" }) } })).target, "mac-arm64");
  assert.equal(
    (
      await detectDownloadDevice({
        ...mac,
        userAgentData: {
          getHighEntropyValues: async () => {
            throw new Error("denied");
          },
        },
      })
    ).target,
    null,
  );
  assert.equal((await detectDownloadDevice({ ...mac, userAgentData: { getHighEntropyValues: async () => ({}) } })).target, null);
});

void test("a browser that never resolves its hints does not block manual downloads", async () => {
  assert.equal((await detectDownloadDevice({ ...mac, userAgentData: { getHighEntropyValues: () => new Promise(() => {}) } })).target, null);
});
