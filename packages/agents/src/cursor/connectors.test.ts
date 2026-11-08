import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { cursorConnectorDriver, cursorConnectorStatus } from "./connectors.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

it("uses Cursor's reported MCP state, including disabled and unapproved servers", () => {
  expect(cursorConnectorStatus("docs: ready", "docs")).toEqual({ status: "connected" });
  expect(cursorConnectorStatus("docs: requires_authentication", "docs")).toEqual({ status: "needs-sign-in" });
  expect(cursorConnectorStatus("docs: disabled", "docs")).toEqual({ status: "off" });
  expect(cursorConnectorStatus("docs: not loaded (needs approval)", "docs")).toMatchObject({ status: "failed" });
  expect(cursorConnectorStatus("another: ready", "docs")).toMatchObject({ status: "failed" });
});

it("edits only the named server in Cursor's own config and preserves unrelated fields", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "openorc-cursor-config-"));
  homes.push(home);
  const driver = cursorConnectorDriver({ binary: "cursor-agent", env: { HOME: home } });
  await driver.save("docs", { kind: "url", url: "https://docs.example/mcp", headers: {} });
  const file = path.join(home, ".cursor", "mcp.json");
  await writeFile(file, JSON.stringify({ mcpServers: { docs: { url: "https://docs.example/mcp", timeout: 40 }, other: { command: "example" } }, custom: true }));
  await driver.save("docs", { kind: "command", command: "node", args: ["server.js"], env: {} });
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ mcpServers: { docs: { timeout: 40, command: "node", args: ["server.js"], env: {} }, other: { command: "example" } }, custom: true });
  await driver.remove("docs");
  expect(await driver.spec("docs")).toBeNull();
  expect(await driver.spec("other")).toEqual({ kind: "command", command: "example", args: [], env: {} });
});
