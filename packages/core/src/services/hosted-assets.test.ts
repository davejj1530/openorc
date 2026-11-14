import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHosted, type CloudFileScope, type Hosted } from "@openorc/hosted";
import { standIn, type StandIn } from "@openorc/hosted/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hostDeps, newDevice, signInAs } from "../../../hosted/src/test-fixtures/host.js";
import { HostedAssets } from "./hosted-assets.js";
import { hostedDownloadName, hostedThumbnail } from "./hosted-asset-bytes.js";

const email = "reader@example.com";
let directory: string;
let stand: StandIn;
let hosted: Hosted;
let scope: CloudFileScope;
let assets: HostedAssets;
const choose = vi.fn<(name: string) => Promise<string | null>>();

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "openorc-file-download-"));
  stand = await standIn({ signup: "open" });
  const projectId = stand.addProject(email, { name: "example", fullName: "sample/example" });
  const { deps, browser } = hostDeps(stand, newDevice());
  hosted = createHosted(deps);
  await hosted.start();
  await signInAs(hosted, browser, email);
  await hosted.spaces.refresh();
  scope = await hosted.files.capture({ accountId: `user-${email}`, apiOrigin: stand.url, spaceId: `personal-${email}`, destination: { kind: "hosted", projectId } });
  choose.mockReset().mockResolvedValue(path.join(directory, "saved.bin"));
  assets = new HostedAssets({ account: () => hosted, chooseDownload: choose });
});
afterEach(async () => {
  hosted.close();
  await stand.close();
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function upload(bytes: Buffer, name = "notes.txt") {
  const plan = await hosted.files.start(scope, { name, bytes: bytes.length, requestId: randomUUID() });
  await hosted.files.part(
    scope,
    plan,
    1,
    { bytes: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) },
    { signal: new AbortController().signal, progress: () => undefined },
  );
  return hosted.files.complete(scope, plan.id);
}

it("downloads exact original bytes to the chosen file without leaving a temporary copy", async () => {
  const bytes = Buffer.alloc(1024 * 1024 + 31, 123);
  bytes.write("Last bytes", bytes.length - 10);
  const file = await upload(bytes);
  expect(await assets.download({ scope, file })).toEqual({ saved: true });
  expect(choose).toHaveBeenCalledWith("notes.txt");
  expect(await readFile(path.join(directory, "saved.bin"))).toEqual(bytes);
  expect(await readdir(directory)).toEqual(["saved.bin"]);
});

it("cancels without reading the file and refuses an account changed while Save As was open", async () => {
  const file = await upload(Buffer.from("Original"));
  const read = vi.spyOn(hosted.files, "read");
  choose.mockResolvedValueOnce(null);
  expect(await assets.download({ scope, file })).toEqual({ saved: false });
  expect(read).not.toHaveBeenCalled();
  choose.mockImplementationOnce(async () => {
    await hosted.account.signOut();
    return path.join(directory, "saved.bin");
  });
  await expect(assets.download({ scope, file })).rejects.toThrow("Your OpenOrc session changed. Try again.");
  expect(await readdir(directory)).toEqual([]);
});

it("keeps an existing destination intact when a response ends before its declared length", async () => {
  await writeFile(path.join(directory, "saved.bin"), "Existing");
  vi.spyOn(hosted.files, "read").mockImplementation(async (_scope, _file, _thumbnail, consume) => consume(new Response("Short", { headers: { "content-length": "100" } })));
  await expect(assets.download({ scope, file: { id: "file-id", name: "notes.txt" } })).rejects.toThrow("This file didn't finish downloading. Try again.");
  expect(await readFile(path.join(directory, "saved.bin"), "utf8")).toBe("Existing");
  expect(await readdir(directory)).toEqual(["saved.bin"]);
});

it("returns only a checked small WebP for a picture and preserves a missing thumbnail refusal", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNIK+9IK+9ggFAAJpIFlVMG4ZAAAAAASUVORK5CYII=", "base64");
  const file = await upload(png, "picture.png");
  const thumbnail = await assets.thumbnail({ scope, file });
  expect(thumbnail.contentType).toBe("image/webp");
  expect(Buffer.from(thumbnail.data, "base64").subarray(8, 12).toString()).toBe("WEBP");
  const text = await upload(Buffer.from("Text"));
  await expect(assets.thumbnail({ scope, file: text })).rejects.toThrow("That file has no thumbnail.");
});

it("refuses a non-raster or oversized thumbnail response before sending it to the window", async () => {
  await expect(hostedThumbnail(new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }))).rejects.toThrow("This image couldn't be opened. Try again.");
  await expect(hostedThumbnail(new Response(Buffer.alloc(1024 * 1024 + 1), { headers: { "content-type": "image/webp" } }))).rejects.toThrow("This image couldn't be opened. Try again.");
  expect(hostedDownloadName("../folder\\notes\u0000.txt")).toBe("notes.txt");
  expect(hostedDownloadName("..")).toBe("file");
  expect(Buffer.byteLength(hostedDownloadName("é".repeat(200)))).toBeLessThanOrEqual(200);
});

it("cancels the response when a thumbnail exceeds its bound", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024 + 1));
    },
    cancel,
  });
  await expect(hostedThumbnail(new Response(body, { headers: { "content-type": "image/webp" } }))).rejects.toThrow("This image couldn't be opened. Try again.");
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});
