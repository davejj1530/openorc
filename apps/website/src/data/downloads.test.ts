import assert from "node:assert/strict";
import { test } from "node:test";
import { publishedReleases } from "./changelog";
import { selectDownloadRelease } from "./downloads";

function release(tag = "v0.1.0-beta.4", changes: Record<string, unknown> = {}) {
  const names = [`OpenOrc-${tag.slice(1)}-mac-arm64.dmg`, `OpenOrc-${tag.slice(1)}-mac-x64.dmg`, `OpenOrc-${tag.slice(1)}-win-x64${tag.includes("beta") ? "-unsigned" : ""}.exe`];
  return {
    tag_name: tag,
    html_url: `https://github.com/davejj1530/openorc/releases/tag/${tag}`,
    draft: false,
    prerelease: tag.includes("beta"),
    published_at: "2026-09-28T10:00:00Z",
    assets: names.map((name) => ({ name, size: 250_000_000, state: "uploaded", browser_download_url: `https://github.com/davejj1530/openorc/releases/download/${tag}/${name}` })),
    ...changes,
  };
}

void test("offers the three real beta installers and identifies unsigned Windows", () => {
  const result = selectDownloadRelease(publishedReleases([release()]));
  assert.equal(result?.tag, "v0.1.0-beta.4");
  assert.deepEqual(
    result?.installers.map(({ target, unsigned }) => ({ target, unsigned })),
    [
      { target: "mac-arm64", unsigned: false },
      { target: "mac-x64", unsigned: false },
      { target: "win-x64", unsigned: true },
    ],
  );
});

void test("never advertises draft, missing, unfinished, or foreign assets", () => {
  assert.equal(selectDownloadRelease(publishedReleases([release("v0.1.0-beta.4", { draft: true })])), null);
  const asset = release().assets[0]!;
  for (const invalid of [
    { ...asset, state: "starter" },
    { ...asset, size: 0 },
    { ...asset, size: NaN },
    { ...asset, browser_download_url: asset.browser_download_url.replace("github.com", "example.com") },
    { ...asset, browser_download_url: asset.browser_download_url.replace("v0.1.0-beta.4/", "v0.0.1/") },
    { ...asset, name: "not-an-installer.zip" },
  ])
    assert.equal(selectDownloadRelease(publishedReleases([release("v0.1.0-beta.4", { assets: [invalid] })])), null);
  assert.equal(selectDownloadRelease(publishedReleases([])), null);
});

void test("prefers stable releases, and does not invent missing platform downloads", () => {
  const stable = release("v0.1.0", { published_at: "2026-09-27T10:00:00Z" });
  assert.equal(selectDownloadRelease(publishedReleases([release(), stable]))?.tag, "v0.1.0");
  const partial = release();
  partial.assets = partial.assets.slice(0, 1);
  assert.deepEqual(
    selectDownloadRelease(publishedReleases([partial]))?.installers.map((item) => item.target),
    ["mac-arm64"],
  );
});

void test("offers each Linux package under its format's own architecture name", () => {
  const tag = "v0.2.0";
  const linux = release(tag);
  const names = ["OpenOrc-0.2.0-linux-x86_64.rpm", "OpenOrc-0.2.0-linux-amd64.deb", "OpenOrc-0.2.0-linux-x86_64.AppImage", "OpenOrc-0.2.0-linux-x64.rpm"];
  linux.assets = names.map((name) => ({ name, size: 110_000_000, state: "uploaded", browser_download_url: `https://github.com/davejj1530/openorc/releases/download/${tag}/${name}` }));
  assert.deepEqual(
    selectDownloadRelease(publishedReleases([linux]))?.installers.map(({ target, name, unsigned }) => ({ target, name, unsigned })),
    [
      { target: "linux-rpm", name: "OpenOrc-0.2.0-linux-x86_64.rpm", unsigned: false },
      { target: "linux-deb", name: "OpenOrc-0.2.0-linux-amd64.deb", unsigned: false },
      { target: "linux-appimage", name: "OpenOrc-0.2.0-linux-x86_64.AppImage", unsigned: false },
    ],
  );
});

void test("does not offer an unsigned installer as a stable Windows release", () => {
  const stable = release("v0.1.0");
  stable.assets = [
    { ...stable.assets[2]!, name: "OpenOrc-0.1.0-win-x64-unsigned.exe", browser_download_url: "https://github.com/davejj1530/openorc/releases/download/v0.1.0/OpenOrc-0.1.0-win-x64-unsigned.exe" },
  ];
  assert.equal(selectDownloadRelease(publishedReleases([stable])), null);
});
