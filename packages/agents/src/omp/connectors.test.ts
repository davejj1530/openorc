import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ompServerConfig, ompUserServers } from "./connectors.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("Oh My Pi's connectors", () => {
  it("hands a run the user's servers that are on, as ACP describes them", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "omp-mcp-"));
    folders.push(dir);
    writeFileSync(
      path.join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          paper: { type: "http", url: "https://paper.example/mcp", headers: { Authorization: "Bearer x" } },
          feed: { type: "sse", url: "https://feed.example/sse" },
          local: { type: "stdio", command: "node", args: ["server.js"], env: { TOKEN: "t" } },
          off: { type: "stdio", command: "off-server", enabled: false },
          muted: { type: "stdio", command: "muted-server" },
        },
        disabledServers: ["muted"],
      }),
    );
    expect(await ompUserServers({ PI_CODING_AGENT_DIR: dir })).toEqual([
      { type: "http", name: "paper", url: "https://paper.example/mcp", headers: [{ name: "Authorization", value: "Bearer x" }] },
      { type: "sse", name: "feed", url: "https://feed.example/sse", headers: [] },
      { name: "local", command: "node", args: ["server.js"], env: [{ name: "TOKEN", value: "t" }] },
    ]);
  });

  it("allows a missing configuration but reports an unreadable one", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "omp-mcp-"));
    folders.push(dir);
    expect(await ompUserServers({ PI_CODING_AGENT_DIR: dir })).toEqual([]);
    writeFileSync(path.join(dir, "mcp.json"), "{ not json");
    await expect(ompUserServers({ PI_CODING_AGENT_DIR: dir })).rejects.toThrow("Oh My Pi's mcp.json could not be read");
  });

  it("saves a connector over what Oh My Pi kept, leaving settings OpenOrc does not edit", () => {
    expect(ompServerConfig({ type: "stdio", command: "old", timeout: 30, enabled: false }, { kind: "url", url: "https://x.example/mcp", headers: {} })).toEqual({
      type: "http",
      url: "https://x.example/mcp",
      timeout: 30,
      enabled: false,
    });
    expect(ompServerConfig(undefined, { kind: "command", command: "npx", args: ["-y", "srv"], env: {} })).toEqual({ type: "stdio", command: "npx", args: ["-y", "srv"] });
  });
});
