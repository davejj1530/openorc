import { afterEach, expect, it, vi } from "vitest";
import { WebClient } from "@slack/web-api";
import { mkdtemp, rm, unlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Db } from "@openorc/db";
import { AttachmentService } from "../attachments.js";
import { SlackImages, downloadSlackImage } from "./images.js";
import { MAX_IMAGE_BYTES } from "../attachments.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=";
afterEach(() => vi.restoreAllMocks());
function fixture(url = "https://files.slack.com/files-pri/T-F/image.png") {
  const web = new WebClient("xoxb-fixture");
  vi.spyOn(web.files, "info").mockResolvedValue({ ok: true, file: { id: "FIMAGE", name: "reference.png", mimetype: "image/png", url_private: url } });
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(Buffer.from(png, "base64")));
  return { web, fetch, download: () => downloadSlackImage(web, "xoxb-fixture", "FIMAGE") };
}
it("downloads private images with bearer auth, returning bytes without private URLs", async () => {
  const f = fixture();
  expect(await f.download()).toEqual({ name: "reference.png", mime: "image/png", dataBase64: png });
  expect(f.fetch).toHaveBeenCalledWith("https://files.slack.com/files-pri/T-F/image.png", expect.objectContaining({ headers: { Authorization: "Bearer xoxb-fixture" }, redirect: "manual" }));
});
it.each(["http://files.slack.com/image.png", "https://files.slack.com.evil.test/image.png", "https://127.0.0.1/image.png", "https://user:pass@files.slack.com/image.png"])(
  "never sends credentials to an unsafe download URL: %s",
  async (url) => {
    const f = fixture(url);
    expect(await f.download()).toEqual({ error: expect.stringContaining("unsupported") });
    expect(f.fetch).not.toHaveBeenCalled();
  },
);
it("does not forward credentials outside Slack on redirects", async () => {
  const f = fixture();
  f.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://evil.test/image.png" } }));
  expect(await f.download()).toEqual({ error: expect.stringContaining("unsupported") });
  expect(f.fetch).toHaveBeenCalledTimes(1);
});
it("follows an authenticated redirect within the Slack file host", async () => {
  const f = fixture();
  f.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/files-pri/T-F/full.png" } }));
  expect(await f.download()).toMatchObject({ dataBase64: png });
  expect(f.fetch).toHaveBeenCalledTimes(2);
});
it("reports the missing scope without exposing SDK payloads or credentials", async () => {
  const f = fixture();
  vi.mocked(f.web.files.info).mockRejectedValue({ data: { error: "missing_scope" }, message: "xoxb-secret https://private" });
  expect(await f.download()).toEqual({ error: "Slack image access needs files:read. Add that bot scope and reinstall the Slack app in your workspace." });
  expect(f.fetch).not.toHaveBeenCalled();
});
it("bounds downloads even when Slack omits Content-Length", async () => {
  const f = fixture();
  const cancel = vi.fn();
  f.fetch.mockResolvedValueOnce(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES + 1));
        },
        cancel,
      }),
    ),
  );
  expect(await f.download()).toEqual({ error: "This image exceeds the 20 MB limit." });
  expect(cancel).toHaveBeenCalled();
});

it("keeps validated images across restarts, refetches missing files, and rejects invalid bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slack-image-cache-"));
  let db = Db.open(join(dir, "cache.sqlite"));
  try {
    const storage = new AttachmentService(dir);
    const download = vi.fn(async () => ({ name: "reference.png", mime: "image/png", dataBase64: png }));
    const file = { id: "FIMAGE" };
    const first = await new SlackImages(db, storage).load("TTEAM", file, download);
    expect(first).toMatchObject({ path: expect.stringContaining("attachments/"), name: "reference.png" });
    db.close();
    db = Db.open(join(dir, "cache.sqlite"));
    const cache = new SlackImages(db, storage);
    if (!("path" in first)) throw new Error("Expected saved image");
    expect(await cache.load("TTEAM", file, download)).toEqual({ ...first, path: await realpath(first.path) });
    expect(download).toHaveBeenCalledTimes(1);
    if (!("path" in first)) throw new Error("Expected saved image");
    await unlink(first.path);
    expect(await cache.load("TTEAM", file, download)).not.toEqual(first);
    expect(download).toHaveBeenCalledTimes(2);
    const invalid = vi.fn(async () => ({ name: "login.png", mime: "image/png", dataBase64: Buffer.from("<html>Log in</html>").toString("base64") }));
    expect(await cache.load("TTEAM", { id: "FINVALID" }, invalid)).toEqual({ error: expect.stringContaining("not a valid supported image") });
    await cache.load("TTEAM", { id: "FINVALID" }, invalid);
    expect(invalid).toHaveBeenCalledTimes(2); // failures never poison the cache
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
