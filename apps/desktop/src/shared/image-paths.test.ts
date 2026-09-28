import { expect, it } from "vitest";
import { imageSource, localPath } from "./image-paths";

it("keeps local paths out of website routing and resolves relative links in the workspace", () => {
  expect(localPath("/tmp/logo%20concept.png")).toBe("/tmp/logo concept.png");
  expect(localPath("file:///tmp/logo%23final.png")).toBe("/tmp/logo#final.png");
  expect(localPath("output/logo.png", "/repo/worktree")).toBe("/repo/worktree/output/logo.png");
  expect(localPath("file:///C:/images/logo.png")).toBe("C:/images/logo.png");
  expect(imageSource("/tmp/logo%20concept.png")).toBe("openorc-asset://local-image/?path=%2Ftmp%2Flogo%20concept.png");
});

it("rejects network files, executable URLs, malformed paths and non-images", () => {
  for (const url of [
    "https://example.com/logo.png",
    "file://server/logo.png",
    "//server/logo.png",
    "javascript:alert(1)",
    "/tmp/bad%00.png",
    "file:///tmp/bad%00.png",
    "%2F%2Fserver/image.png",
    "/tmp/bad%XX.png",
    "/tmp/file.txt",
  ]) {
    expect(imageSource(url)).toBeNull();
  }
});
