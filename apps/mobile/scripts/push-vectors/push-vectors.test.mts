import vectorFile from "@openorc/link/test-fixtures/push-vectors.json" with { type: "json" };
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const opener = resolve(import.meta.dirname, "../../targets/notification-service/PushOpener.swift");
const main = resolve(import.meta.dirname, "main.swift");

// macOS has CryptoKit, so the extension's own opener runs here as it does on the phone. A Mac without swiftc fails.
it.runIf(process.platform === "darwin")(
  "the extension's opener reads every alert the Mac seals and refuses every bad one",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "openorc-push-vectors-"));
    try {
      const binary = join(dir, "push-vectors");
      execFileSync("swiftc", [opener, main, "-o", binary], { stdio: "pipe" });
      const report = JSON.parse(execFileSync(binary, { input: JSON.stringify(vectorFile) }).toString("utf8"));
      expect(report.good).toEqual(vectorFile.good.map(({ name, notice }) => ({ name, notice })));
      expect(report.bad).toEqual(vectorFile.bad.map(({ name }) => ({ name, error: expect.any(String) })));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  180_000,
);
