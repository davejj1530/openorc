import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { imageAssetResponse } from "./image-assets";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("serves generated images outside attachments with the correct MIME and literal filename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openorc-image-test-"));
  dirs.push(dir);
  const path = join(dir, "logo #1.svg");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" />';
  await writeFile(path, svg);
  const response = await imageAssetResponse(new Request(`openorc-asset://local-image/?path=${encodeURIComponent(path)}`), dir);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/svg+xml");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(await response.text()).toBe(svg);
  await mkdir(join(dir, "attachments"));
  await writeFile(join(dir, "attachments", "abc-123.png"), "fixture");
  expect((await imageAssetResponse(new Request("openorc-asset://attachments/abc-123.png"), dir)).status).toBe(200);
});

it("rejects non-images, relative paths, missing files and attachment traversal", async () => {
  for (const [url, status] of [
    ["openorc-asset://local-image/?path=%2Ftmp%2Fsecret.txt", 415],
    ["openorc-asset://local-image/?path=relative.png", 400],
    ["openorc-asset://local-image/?path=%2Fnonexistent-openorc-image.png", 404],
    ["openorc-asset://attachments/..%2Fsecret.png", 404],
  ] as const)
    expect((await imageAssetResponse(new Request(url), "/tmp")).status).toBe(status);
});

it("serves a tool's stored image from its run folder and nothing outside it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openorc-tool-image-test-"));
  dirs.push(dir);
  await mkdir(join(dir, "tool-images", "run-1"), { recursive: true });
  await writeFile(join(dir, "tool-images", "run-1", "0a1b-2c.png"), "fixture");
  const response = await imageAssetResponse(new Request("openorc-asset://tool-images/run-1/0a1b-2c.png"), dir);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  for (const url of ["openorc-asset://tool-images/run-1/..%2F..%2Fsecret.png", "openorc-asset://tool-images/run-1/notes.txt", "openorc-asset://tool-images/0a1b-2c.png"])
    expect((await imageAssetResponse(new Request(url), dir)).status).toBe(404);
});
