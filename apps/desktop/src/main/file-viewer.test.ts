import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { signFileUrl } from "@openorc/core/file-url";
import { fileResponse, installFileViewer } from "./file-viewer";

const fake = vi.hoisted(() => ({ ipcHandle: vi.fn(), protocolHandle: vi.fn(), openPath: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle: fake.ipcHandle }, protocol: { handle: fake.protocolHandle }, shell: { openPath: fake.openPath } }));

const key = "k".repeat(64);
let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "openorc-file-viewer-")));
});
afterEach(async () => {
  vi.clearAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const signed = (path: string) => signFileUrl(key, path, "1");
const request = (url: string, init?: RequestInit) => fileResponse(new Request(url, init), key);

it("serves a signed file as its own type, inert, with no caching, and lets only the PDF viewer run", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>1</script></svg>';
  await writeFile(join(dir, "mark.svg"), svg);
  const image = await request(signed(join(dir, "mark.svg")));
  expect(image.status).toBe(200);
  const header = (name: string) => image.headers.get(name);
  expect([header("content-type"), header("x-content-type-options"), header("cache-control"), header("accept-ranges"), header("content-length")]).toEqual([
    "image/svg+xml",
    "nosniff",
    "no-store",
    "bytes",
    String(svg.length),
  ]);
  expect(header("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
  expect(await image.text()).toBe(svg);
  await writeFile(join(dir, "deck.pdf"), "%PDF-1.4");
  const pdf = await request(signed(join(dir, "deck.pdf")));
  expect(pdf.headers.get("content-type")).toBe("application/pdf");
  expect(pdf.headers.get("content-security-policy")).toBeNull();
  await writeFile(join(dir, "data.bin"), Buffer.from([0, 1, 2]));
  expect((await request(signed(join(dir, "data.bin")))).headers.get("content-type")).toBe("application/octet-stream");
  await writeFile(join(dir, "empty.png"), "");
  const empty = await request(signed(join(dir, "empty.png")));
  expect([empty.status, empty.headers.get("content-length"), await empty.text()]).toEqual([200, "0", ""]);
});

it("refuses a changed path or signature, another key, any other method, and names nothing that is not the signed file", async () => {
  await writeFile(join(dir, "photo.png"), "png");
  const url = signed(join(dir, "photo.png"));
  expect((await request(url.replace("photo", "secret"))).status).toBe(403);
  expect((await request(url.replace(/sig=(.)/, (_, first: string) => `sig=${first === "0" ? "1" : "0"}`))).status).toBe(403);
  expect((await request(signFileUrl("other", join(dir, "photo.png"), "1"))).status).toBe(403);
  expect((await request(url, { method: "POST" })).status).toBe(405);
  expect((await request(signed(join(dir, "gone.png")))).status).toBe(404);
  expect((await request(signed(dir))).status).toBe(404);
  await writeFile(join(dir, "secret.txt"), "key material");
  await symlink(join(dir, "secret.txt"), join(dir, "swapped.png"));
  expect((await request(signed(join(dir, "swapped.png")))).status).toBe(404);
});

it("answers a byte range with 206 and exactly those bytes, so video and audio can seek, and the whole file to any other range header", async () => {
  await writeFile(join(dir, "clip.mp4"), Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  const url = signed(join(dir, "clip.mp4"));
  const part = await request(url, { headers: { Range: "bytes=10-19" } });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe("bytes 10-19/256");
  expect(part.headers.get("content-length")).toBe("10");
  expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  const tail = await request(url, { headers: { Range: "bytes=250-" } });
  expect(tail.headers.get("content-range")).toBe("bytes 250-255/256");
  expect([...new Uint8Array(await tail.arrayBuffer())]).toEqual([250, 251, 252, 253, 254, 255]);
  const suffix = await request(url, { headers: { Range: "bytes=-3" } });
  expect([...new Uint8Array(await suffix.arrayBuffer())]).toEqual([253, 254, 255]);
  const past = await request(url, { headers: { Range: "bytes=300-" } });
  expect(past.status).toBe(416);
  expect(past.headers.get("content-range")).toBe("bytes */256");
  for (const range of [undefined, "bytes=0-9,20-29", "bytes=abc", "items=0-9"]) {
    const whole = await request(url, range === undefined ? undefined : { headers: { Range: range } });
    expect([whole.status, whole.headers.get("content-range"), (await whole.arrayBuffer()).byteLength]).toEqual([200, null, 256]);
  }
});

function event(url: string, sameFrame = true): IpcMainInvokeEvent {
  const frame = { url };
  return { senderFrame: frame, sender: { mainFrame: sameFrame ? frame : { url } } } as unknown as IpcMainInvokeEvent;
}

it("opens a signed file in its default app for the app's main frame and nobody else", async () => {
  installFileViewer(key, (url) => url === "https://app.test/");
  expect(fake.protocolHandle).toHaveBeenCalledWith("openorc-file", expect.any(Function));
  const open = fake.ipcHandle.mock.calls.find((call) => call[0] === "shell:openFile")![1] as (event: IpcMainInvokeEvent, url: unknown) => Promise<string>;
  await writeFile(join(dir, "report.pdf"), "%PDF");
  const url = signed(join(dir, "report.pdf"));
  fake.openPath.mockResolvedValue("");
  await expect(open(event("https://app.test/"), url)).resolves.toBe("");
  expect(fake.openPath).toHaveBeenCalledWith(join(dir, "report.pdf"));
  expect(() => open(event("https://other.test/"), url)).toThrow("Only the app window");
  expect(() => open(event("https://app.test/", false), url)).toThrow("Only the app window");
  expect(() => open(event("https://app.test/"), url.replace("report", "secret"))).toThrow("names no file");
  expect(() => open(event("https://app.test/"), join(dir, "report.pdf"))).toThrow("names no file");
  expect(fake.openPath).toHaveBeenCalledTimes(1);
});

it("keeps programs, swapped links and missing files closed, and says so in the app's words", async () => {
  installFileViewer(key, () => true);
  const open = fake.ipcHandle.mock.calls.find((call) => call[0] === "shell:openFile")![1] as (event: IpcMainInvokeEvent, url: unknown) => Promise<string>;
  await writeFile(join(dir, "tool"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  await chmod(join(dir, "tool"), 0o755);
  await expect(open(event("https://app.test/"), signed(join(dir, "tool")))).resolves.toBe("Programs can’t be opened from here.");
  await writeFile(join(dir, "secret.txt"), "key material");
  await symlink(join(dir, "secret.txt"), join(dir, "swapped.png"));
  await expect(open(event("https://app.test/"), signed(join(dir, "swapped.png")))).resolves.toBe("Could not open this file.");
  await expect(open(event("https://app.test/"), signed(join(dir, "gone.png")))).resolves.toBe("Could not open this file.");
  expect(fake.openPath).not.toHaveBeenCalled();
  await writeFile(join(dir, "data.bin"), Buffer.from([0, 1]));
  fake.openPath.mockResolvedValue("No application knows this file.");
  await expect(open(event("https://app.test/"), signed(join(dir, "data.bin")))).resolves.toBe("Could not open this file.");
});
