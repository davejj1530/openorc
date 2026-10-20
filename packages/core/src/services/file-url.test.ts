import { expect, it } from "vitest";
import { signFileUrl, verifyFileUrl } from "./file-url.js";

const key = "k".repeat(64);
const path = "/Users/me/project/docs/plan #1 & co, 100%+ done é 🎉.pdf";

it("names the signed path again with every character it had, and a new version changes the URL without touching the signature", () => {
  const url = signFileUrl(key, path, "7-42");
  expect(url).toMatch(/^openorc-file:\/\/file\/\?path=%2FUsers%2Fme%2Fproject%2Fdocs%2Fplan%20%231%20%26%20co%2C%20100%25%2B%20done%20%C3%A9%20%F0%9F%8E%89\.pdf&sig=[a-f0-9]{64}&v=7-42$/);
  expect(verifyFileUrl(key, url)).toBe(path);
  const later = signFileUrl(key, path, "8-42");
  expect(later).not.toBe(url);
  expect(later.replace(/&v=.*$/, "")).toBe(url.replace(/&v=.*$/, ""));
  expect(verifyFileUrl(key, later)).toBe(path);
});

it("refuses a changed path, a changed or short signature, another key, and anything that is not its own scheme", () => {
  const url = signFileUrl(key, path, "1");
  const sig = /&sig=([a-f0-9]+)/.exec(url)![1]!;
  const flipped = `${sig.slice(0, -1)}${sig.endsWith("0") ? "1" : "0"}`;
  expect(verifyFileUrl(key, url.replace("plan", "secret"))).toBeNull();
  expect(verifyFileUrl(key, url.replace(sig, flipped))).toBeNull();
  expect(verifyFileUrl(key, url.replace(sig, sig.slice(1)))).toBeNull();
  expect(verifyFileUrl("other", url)).toBeNull();
  expect(verifyFileUrl(key, url.replace("openorc-file://file/", "openorc-asset://local-image/"))).toBeNull();
  expect(verifyFileUrl(key, "not a url")).toBeNull();
});

it("never names a relative path, whatever signed it", () => {
  expect(verifyFileUrl(key, signFileUrl(key, "docs/plan.pdf", "1"))).toBeNull();
});
