import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensureElectronBinary } from "./electron-binary.global-setup";

let folder: string;
afterEach(() => rmSync(folder, { recursive: true, force: true }));

/** An Electron package whose installer notes where each try fetched from, and succeeds from the try `succeeds` on. */
function fakeElectron(succeeds: number): string {
  folder = mkdtempSync(path.join(tmpdir(), "openorc-electron-binary-"));
  writeFileSync(
    path.join(folder, "install.js"),
    `const fs = require("node:fs"), path = require("node:path");
     const log = path.join(__dirname, "tries.txt");
     fs.appendFileSync(log, (process.env.ELECTRON_MIRROR ?? "github") + "\\n");
     if (fs.readFileSync(log, "utf8").trim().split("\\n").length < ${succeeds}) process.exit(1);
     fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
     fs.writeFileSync(path.join(__dirname, "dist", "electron"), "");
     fs.writeFileSync(path.join(__dirname, "path.txt"), "electron");`,
  );
  return folder;
}
const tries = () => readFileSync(path.join(folder, "tries.txt"), "utf8").trim().split("\n");

it("fetches a missing binary from the mirror when GitHub fails, and leaves a binary that is there alone", async () => {
  const electron = fakeElectron(2);
  await ensureElectronBinary(electron, async () => {});
  expect(tries()).toEqual(["github", "https://npmmirror.com/mirrors/electron/"]);
  await ensureElectronBinary(electron, async () => {});
  expect(tries()).toHaveLength(2);
});

it("alternates between GitHub and the mirror, then says it could not fetch the binary", async () => {
  const electron = fakeElectron(99);
  const waits: number[] = [];
  await expect(ensureElectronBinary(electron, async (attempt) => void waits.push(attempt))).rejects.toThrow("could not be downloaded in 4 tries");
  expect(tries()).toEqual(["github", "https://npmmirror.com/mirrors/electron/", "github", "https://npmmirror.com/mirrors/electron/"]);
  expect(waits).toEqual([1, 2, 3]);
});
