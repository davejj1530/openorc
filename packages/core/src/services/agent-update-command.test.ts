import { afterEach, expect, it, vi } from "vitest";
import { runUpdateCommand } from "./agent-update-installation.js";
afterEach(() => vi.useRealTimers());
it("captures successful probe output without invoking a shell", async () => {
  expect(await runUpdateCommand({ binary: process.execPath, args: ["-e", "process.stdout.write(process.argv[1])", "literal $(echo unsafe)"] }, process.env)).toBe("literal $(echo unsafe)");
});
it("does not expose package-manager output on failure", async () => {
  await expect(runUpdateCommand({ binary: process.execPath, args: ["-e", "console.error('registry-token-secret'); process.exit(1)"] }, process.env)).rejects.toThrow(/^The updater could not finish\./);
});
it("bounds output and returns an actionable failure", async () => {
  await expect(runUpdateCommand({ binary: process.execPath, args: ["-e", "process.stdout.write('a'.repeat(2 * 1024 * 1024))"] }, process.env)).rejects.toThrow("updater could not finish");
});
it("terminates a timed-out updater", async () => {
  vi.useFakeTimers();
  const operation = runUpdateCommand({ binary: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, process.env);
  const assertion = expect(operation).rejects.toThrow("update timed out");
  await vi.advanceTimersByTimeAsync(180_001);
  await assertion;
});
it("handles a missing executable without leaking its environment", async () => {
  await expect(runUpdateCommand({ binary: "/openorc-fixture-missing/updater", args: [] }, { SECRET: "do-not-expose" })).rejects.toThrow("updater could not finish");
});
