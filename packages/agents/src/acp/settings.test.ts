import { expect, it, vi } from "vitest";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { AcpSettings, selectedModel, setModelOption } from "./settings.js";
import { fxAcp } from "../fx/acp.js";

function session() {
  const values: Record<string, string> = { provider: "first", model: "fast", effort: "low", mode: "ask" };
  const options = (): SessionConfigOption[] => Object.entries(values).map(([id, currentValue]) => ({ id, name: id, type: "select", currentValue, options: [] }));
  const write = vi.fn(async (id: string, value: string) => {
    if (value === "rejected") throw new Error("Setting rejected");
    values[id] = value;
    return options();
  });
  const close = vi.fn();
  const settings = new AcpSettings(fxAcp, (id, value) => (id === "model" ? setModelOption(value, fxAcp, write) : write(id, value)), close);
  return { settings, write, close, values, options };
}

it("restores the provider, model and effort after a partially rejected live change", async () => {
  const s = session();
  await s.settings.initialize(s.options(), { runId: "run", agent: "fx", cwd: "/repo", prompt: "hello", permissionMode: "review" });
  await expect(s.settings.apply({ model: "second/reasoner", effort: "rejected" })).rejects.toThrow("Setting rejected");
  expect(s.values).toEqual({ provider: "first", model: "fast", effort: "low", mode: "ask" });
  expect(s.close).not.toHaveBeenCalled();
  await s.settings.apply({ model: "second/reasoner", effort: "high", fastMode: false });
  expect(selectedModel(s.options(), fxAcp)).toBe("second/reasoner");
  expect(s.values.effort).toBe("high");
});

it("closes a session whose previous selection cannot be restored", async () => {
  const s = session();
  await s.settings.initialize(s.options(), { runId: "run", agent: "fx", cwd: "/repo", prompt: "hello", permissionMode: "review" });
  s.write
    .mockImplementationOnce(async () => {
      throw new Error("Disconnected");
    })
    .mockImplementationOnce(async () => {
      throw new Error("Still disconnected");
    });
  await expect(s.settings.apply({ model: "second/reasoner" })).rejects.toThrow("Disconnected");
  expect(s.close).toHaveBeenCalledOnce();
  expect(s.settings.busy).toBe(false);
});

it("restores the original connection when the new provider accepts but its model rejects", async () => {
  const s = session();
  await s.settings.initialize(s.options(), { runId: "run", agent: "fx", cwd: "/repo", prompt: "hello", permissionMode: "review" });
  await expect(s.settings.apply({ model: "second/rejected" })).rejects.toThrow("Setting rejected");
  expect(selectedModel(s.options(), fxAcp)).toBe("first/fast");
});
