import { describe, expect, it } from "vitest";
import { ownServerConfig } from "./server-config.js";

describe("OpenOrc's server in OpenCode's configuration", () => {
  it("lists its tools directly, keeping the user's settings and servers", () => {
    const content = '{ "model": "anthropic/x", "mcp": { "timeout": { "startup": 1000 }, "servers": { "docs": { "type": "remote", "url": "https://docs.example/mcp" } } }, }';
    expect(JSON.parse(ownServerConfig(content, "openorc_1", "http://127.0.0.1:9/mcp"))).toEqual({
      model: "anthropic/x",
      mcp: {
        timeout: { startup: 1000 },
        servers: { docs: { type: "remote", url: "https://docs.example/mcp" }, openorc_1: { type: "remote", url: "http://127.0.0.1:9/mcp", oauth: false, codemode: false } },
      },
    });
    expect(JSON.parse(ownServerConfig(undefined, "openorc_1", "http://127.0.0.1:9/mcp")).mcp.servers.openorc_1.codemode).toBe(false);
  });

  it("refuses a configuration that is not an object", () => {
    expect(() => ownServerConfig("[1]", "openorc_1", "http://127.0.0.1:9/mcp")).toThrow("JSON/JSONC object");
  });
});
