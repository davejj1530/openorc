import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEvent, type RunSpec } from "@openorc/protocol";
import { AcpAdapter, type AcpApprovalRequest } from "../acp/adapter.js";
import type { RunHandle } from "../run-handle.js";
import { fxAcp } from "./acp.js";
import { fxConnectorDriver } from "./connectors.js";
import { fxFixture, completion, toolCompletion } from "./fixture.js";

const binary = process.env["OPENORC_TEST_FX_BIN"];

/** Real native runs using a local model fixture and isolated HOME. No account or paid inference. */
describe.skipIf(!binary)("fx native integration", () => {
  let fixture: Awaited<ReturnType<typeof fxFixture>>;
  const handles: RunHandle[] = [];
  beforeEach(async () => {
    fixture = await fxFixture(binary!);
  });
  afterEach(async () => {
    for (const handle of handles.splice(0)) {
      handle.close();
      await handle.wait();
    }
    await fixture.close();
  });

  function run(overrides: Partial<RunSpec> = {}, onApproval: (request: AcpApprovalRequest) => Promise<"allow" | "deny"> = async () => "deny") {
    const adapter = new AcpAdapter({ profile: fxAcp, onApproval });
    const handle = adapter.start(
      { runId: `run-${handles.length}`, agent: "fx", cwd: fixture.workspace, prompt: "First message", model: "local/fixture-model", mode: "act", permissionMode: "autonomous", ...overrides },
      fixture.launch,
    );
    const events: AgentEvent[] = [];
    handle.on("event", (event) => events.push(AgentEvent.parse(event)));
    handles.push(handle);
    return { handle, events, completed: async (count = 1) => vi.waitFor(() => expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(count), { timeout: 10_000 }) };
  }

  it("discovers connection-specific models without inference or changing saved preferences", async () => {
    const models = await new AcpAdapter({ profile: fxAcp, modelsCwd: fixture.root, onApproval: async () => "deny" }).listModels(fixture.launch);
    expect(models.map((model) => [model.id, model.provider.id, model.isDefault])).toEqual([
      ["local/fixture-model", "local", true],
      ["second/other-model", "second", false],
    ]);
    expect(fixture.requests).toEqual([]);
    expect(JSON.parse(await readFile(path.join(fixture.root, ".fx/settings.json"), "utf8"))).toEqual(fixture.settings);
  }, 35_000);

  it("streams replies, reports tokens, resumes history and switches providers between turns", async () => {
    const first = run({ mcpUrl: `${fixture.url}/mcp` });
    await first.completed();
    expect(first.events).toContainEqual(
      expect.objectContaining({ type: "turn.completed", status: "success", resultText: "Fixture reply", usage: expect.objectContaining({ inputTokens: 12, outputTokens: 3 }) }),
    );
    expect(fixture.mcpCalls).toContain("tools/list");
    const session = first.events.find((event) => event.type === "session.started");
    if (session?.type !== "session.started" || !session.externalSessionId) throw new Error("No native session ID");
    expect(session.model).toBe("local/fixture-model");
    first.handle.close();
    await first.handle.wait();
    const next = run({ resumeSessionId: session.externalSessionId, prompt: "Follow up" });
    await next.completed();
    expect(JSON.stringify(fixture.requests.at(-1)?.messages)).toContain("First message");
    await next.handle.applySettings({ model: "second/other-model" });
    await next.handle.send("Other provider");
    await next.completed(2);
    expect(fixture.requests.at(-1)?.model).toBe("other-model");
    expect(next.events.filter((event) => event.type === "turn.completed").map((event) => event.usage?.model)).toEqual(["local/fixture-model", "second/other-model"]);
  }, 30_000);

  it("offers usage recovery for a provider quota error and accepts the next message", async () => {
    fixture.respond((_body, response) => response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "insufficient_quota", type: "insufficient_quota" } })));
    const active = run();
    await active.completed();
    expect(active.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "activity.updated", label: "Provider error", recovery: { kind: "usage", provider: "fx" } })]));
    expect(active.events.find((event) => event.type === "turn.completed")).toMatchObject({ status: "error" });
    fixture.respond((body, response) => completion(response, body.model, "Recovered"));
    await active.handle.send("Try again");
    await active.completed(2);
    expect(active.events.filter((event) => event.type === "turn.completed").at(-1)).toMatchObject({ status: "success", resultText: "Recovered" });
  }, 20_000);

  it("connects enabled profile MCP servers and keeps the terminal's saved permission mode", async () => {
    const driver = fxConnectorDriver(fixture.launch);
    await driver.save("fixture", { kind: "url", url: `${fixture.url}/mcp`, headers: {} });
    fixture.respond((body, response) => (fixture.requests.length === 1 ? toolCompletion(response, body.model, "mcp_fixture_echo", { text: "hello" }) : completion(response, body.model, "Done")));
    const active = run();
    await active.completed();
    expect(fixture.mcpCalls).toContain("tools/list");
    expect(fixture.mcpCalls).toContain("tools/call");
    expect(JSON.stringify(fixture.requests.at(-1)?.messages)).toContain("Profile connector result");
    const saved = JSON.parse(await readFile(path.join(fixture.root, ".fx/settings.json"), "utf8"));
    expect(saved.permission_mode).toBe("ask");
  }, 20_000);

  it.each(["allow", "deny"] as const)(
    "honors %s on a native write approval",
    async (decision) => {
      fixture.respond((body, response) =>
        fixture.requests.length === 1 ? toolCompletion(response, body.model, "write_file", { path: "result.txt", content: "Fixture contents" }) : completion(response, body.model, "Finished"),
      );
      const approval = vi.fn(async () => decision);
      const active = run({ permissionMode: "review" }, approval);
      await active.completed();
      expect(approval).toHaveBeenCalledOnce();
      if (decision === "allow") expect(await readFile(path.join(fixture.workspace, "result.txt"), "utf8")).toBe("Fixture contents");
      else await expect(readFile(path.join(fixture.workspace, "result.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(active.events).toContainEqual(expect.objectContaining({ type: "turn.completed", status: "success" }));
    },
    20_000,
  );

  it("steers a running turn and cancels a held response", async () => {
    let held: ServerResponse | undefined;
    fixture.respond((body, response) => {
      if (fixture.requests.length === 1) held = response;
      else completion(response, body.model, "Steered reply");
    });
    const active = run();
    await vi.waitFor(() => expect(held).toBeDefined());
    const steering = active.handle.steer("Use the revised instruction");
    await new Promise<void>((resolve) => setImmediate(resolve));
    toolCompletion(held!, "fixture-model", "read_file", { path: "missing.txt" });
    await expect(steering).resolves.toBe("accepted");
    await active.completed();
    expect(JSON.stringify(fixture.requests.at(-1)?.messages)).toContain("Use the revised instruction");
    fixture.respond((_body, response) => {
      held = response;
    });
    held = undefined;
    await active.handle.send("Hold this turn");
    await vi.waitFor(() => expect(held).toBeDefined());
    await active.handle.interrupt();
    await active.completed(2);
    expect(active.events.filter((event) => event.type === "turn.completed").at(-1)).toMatchObject({ status: "cancelled" });
  }, 20_000);

  it("edits native MCP configuration while preserving unrelated settings", async () => {
    const driver = fxConnectorDriver(fixture.launch);
    await driver.save("fixture", { kind: "url", url: `${fixture.url}/mcp`, headers: {} });
    expect(await driver.read(fixture.workspace)).toMatchObject([{ name: "fixture", source: "user", status: "configured" }]);
    await driver.setOn?.("fixture", false);
    expect(await driver.read(fixture.workspace)).toMatchObject([{ name: "fixture", status: "off" }]);
    await driver.remove("fixture");
    expect(await driver.read(fixture.workspace)).toEqual([]);
  });
});
