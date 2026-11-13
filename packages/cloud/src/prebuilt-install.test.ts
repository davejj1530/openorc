import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it } from "vitest";
import { PREBUILT_INSTALL } from "./prebuilt-install.js";

const require = createRequire(import.meta.url);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function install({ checksum, brokenStream = false, cannotWrite = false }: { checksum?: string; brokenStream?: boolean; cannotWrite?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "openorc-prebuilt-test-"));
  directories.push(directory);
  const dest = path.join(directory, "agent");
  await writeFile(dest, "previous binary");
  const content = Buffer.from("new binary");
  const errors: string[] = [];
  const calls: { url: string; signal: AbortSignal }[] = [];
  const execute = runInNewContext(PREBUILT_INSTALL, {
    require(name: string) {
      if (name === "node:child_process") return { execFileSync: () => "glibc" };
      if (name === "node:fs" && cannotWrite)
        return {
          ...fs,
          createWriteStream: () => {
            throw new Error("Disk unavailable");
          },
        };
      return require(name);
    },
    process: {
      argv: ["node", "https://build.example.test/agent", "1.2.3", dest],
      platform: "linux",
      arch: "x64",
      pid: 123,
      exit: () => {
        throw new Error("Installer failed");
      },
    },
    AbortSignal,
    console: { error: (message: string) => errors.push(message) },
    fetch: async (url: string, { signal }: { signal: AbortSignal }) => {
      calls.push({ url, signal });
      if (calls.length === 1)
        return { ok: true, json: async () => ({ download: "https://downloads.example.test/agent", file: { sha256: checksum ?? createHash("sha256").update(content).digest("hex") } }) };
      const body = Readable.from(
        (async function* () {
          yield content;
          if (brokenStream) throw new Error("Connection lost");
        })(),
      );
      return { ok: true, body };
    },
  }) as Promise<void>;
  await execute.catch(() => undefined);
  return { directory, dest, errors, calls };
}

it("replaces the binary only after a complete, verified download", async () => {
  const result = await install();
  expect(result.errors).toEqual([]);
  expect(await readFile(result.dest, "utf8")).toBe("new binary");
  expect((await stat(result.dest)).mode & 0o777).toBe(0o755);
  expect(await readdir(result.directory)).toEqual(["agent"]);
  expect(result.calls.map(({ url }) => url)).toEqual(["https://build.example.test/agent/versions/1.2.3/linux-x86_64", "https://downloads.example.test/agent"]);
  expect(result.calls.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
});

it.each([
  [{ checksum: "0".repeat(64) }, "checksum"],
  [{ brokenStream: true }, "Connection lost"],
  [{ cannotWrite: true }, "Disk unavailable"],
] as const)("keeps the installed binary and removes partial downloads after a failure: %j", async (options, message) => {
  const result = await install(options);
  expect(result.errors.join("\n")).toContain(message);
  expect(await readFile(result.dest, "utf8")).toBe("previous binary");
  expect(await readdir(result.directory)).toEqual(["agent"]);
});
