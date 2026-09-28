import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { AttachmentService, MAX_FILE_BYTES, storedFileName } from "./attachments";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=";
const dirs: string[] = [];
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "task-images-"));
  dirs.push(dir);
  return { dir, service: new AttachmentService(dir) };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("rejects pending, missing, and traversing image references", async () => {
  const { service } = await fixture();
  await expect(service.forTask("![Draft](openorc-pending://abc-123)")).rejects.toThrow("not finished");
  await expect(service.forTask("![Missing](openorc-asset://attachments/abc-123.png)")).rejects.toThrow("missing");
  await expect(service.forTask("![Outside](openorc-asset://attachments/../secret.png)")).rejects.toThrow("invalid");
});

it("rejects symlink escapes from the managed asset directory", async () => {
  const { dir, service } = await fixture();
  await mkdir(path.join(dir, "attachments"));
  await writeFile(path.join(dir, "outside.png"), Buffer.from(png, "base64"));
  await symlink(path.join(dir, "outside.png"), path.join(dir, "attachments/abc-123.png"));
  await expect(service.forTask("![Outside](openorc-asset://attachments/abc-123.png)")).rejects.toThrow("unreadable");
});

it("validates types, bytes, and dimensions before writing", async () => {
  const { service } = await fixture();
  await expect(service.save({ name: "x.png", mime: "image/jpeg", dataBase64: png })).rejects.toThrow("does not match");
  await expect(service.save({ name: "x.svg", mime: "image/svg+xml", dataBase64: png })).rejects.toThrow("Use a PNG");
  await expect(service.save({ name: "x.png", mime: "image/png", dataBase64: "%%%" })).rejects.toThrow("invalid");
  await expect(service.save({ name: "x.png", mime: "image/png", dataBase64: Buffer.from("not an image").toString("base64") })).rejects.toThrow("not a readable");
  const large = Buffer.from(png, "base64");
  large.writeUInt32BE(50000, 16);
  await expect(service.save({ name: "x.png", mime: "image/png", dataBase64: large.toString("base64") })).rejects.toThrow("dimensions");
});

it("keeps a file name from escaping the attachments directory", async () => {
  const { dir, service } = await fixture();
  for (const name of ["../../secret.env", "..\\..\\secret.env", "/etc/passwd", "...."]) {
    const saved = await service.saveFile({ name, dataBase64: Buffer.from("x").toString("base64") });
    expect(path.dirname(saved.path)).toBe(path.join(dir, "attachments"));
    expect(path.basename(saved.path).startsWith(".")).toBe(false);
  }
  expect(storedFileName(`${"n".repeat(200)}.tar.gz`)).toHaveLength(80);
  expect(storedFileName(`${"n".repeat(200)}.tar.gz`).endsWith(".gz")).toBe(true);
});

it("rejects empty, oversized, and malformed file data", async () => {
  const { service } = await fixture();
  await expect(service.saveFile({ name: "  ", dataBase64: Buffer.from("x").toString("base64") })).rejects.toThrow("no name");
  await expect(service.saveFile({ name: "notes.txt", dataBase64: "" })).rejects.toThrow("between 1 byte");
  await expect(service.saveFile({ name: "notes.txt", dataBase64: "%%%" })).rejects.toThrow("invalid");
  await expect(service.saveFile({ name: "big.bin", dataBase64: "A".repeat(Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4) })).rejects.toThrow("20 MB or smaller");
});
