import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMacHello, parseMacMessage, parsePhoneHello, parsePhoneMessage } from "./messages.js";

describe("link messages", () => {
  it.each([
    { t: "rpc", id: 1, method: "threads.list", params: { limit: 13 } },
    { t: "rpc", id: 2, method: "projects.list" },
    { t: "interest", runIds: [] },
    { t: "asset", id: 3, ref: { kind: "attachment", name: "0b9f.png" } },
    { t: "asset", id: 4, ref: { kind: "activity", runId: "run", activityId: "activity" } },
    { t: "asset", id: 2 ** 32 - 1, ref: { kind: "attachment", name: "0b9f.png" } },
    { t: "asset", id: 6, ref: { kind: "preview", threadId: "thread-1", seq: 12 } },
    { t: "ping", id: 5 },
  ])("accept the phone message %j", (message) => {
    expect(parsePhoneMessage(message)).toBe(message);
  });

  it.each([
    ["an unknown tag", { t: "subscribe", runIds: [] }],
    ["an inherited name as the tag", { t: "toString" }],
    ["a prototype key as the tag", { t: "__proto__" }],
    ["an extra key", { t: "ping", id: 1, extra: true }],
    ["a fractional id", { t: "ping", id: 1.5 }],
    ["a negative id", { t: "rpc", id: -1, method: "threads.list" }],
    ["an empty method", { t: "rpc", id: 1, method: "" }],
    ["too many runs of interest", { t: "interest", runIds: Array.from({ length: 257 }, (_, i) => `run-${i}`) }],
    ["an asset id a byte stream cannot carry", { t: "asset", id: 2 ** 32, ref: { kind: "attachment", name: "0b9f.png" } }],
    ["an asset by path", { t: "asset", id: 1, ref: { kind: "path", path: "/etc/passwd" } }],
    ["an asset with an extra field", { t: "asset", id: 1, ref: { kind: "attachment", name: "a.png", path: "/etc/passwd" } }],
    ["a preview frame without its seq", { t: "asset", id: 1, ref: { kind: "preview", threadId: "thread-1" } }],
    ["a preview frame by a fractional seq", { t: "asset", id: 1, ref: { kind: "preview", threadId: "thread-1", seq: 1.5 } }],
    ["a preview frame of an overlong thread id", { t: "asset", id: 1, ref: { kind: "preview", threadId: "t".repeat(101), seq: 1 } }],
    ["a Mac message", { t: "pong", id: 1 }],
    ["an array", [{ t: "ping", id: 1 }]],
    ["null", null],
  ])("refuse a phone message with %s", (_case, message) => {
    expect(() => parsePhoneMessage(message)).toThrow("not a phone message");
  });

  it("check hellos in each direction", () => {
    expect(parsePhoneHello({ t: "hello", version: 1, device: { name: "Phone" }, pair: { offerId: "o", secret: "s" } })).toBeTruthy();
    expect(() => parsePhoneHello({ t: "hello", version: 1, device: { name: "Phone", model: "x" } })).toThrow();
    expect(() => parsePhoneHello({ t: "refused", reason: "busy" })).toThrow();
    expect(parseMacHello({ t: "refused", reason: "unpaired" })).toEqual({ t: "refused", reason: "unpaired" });
    expect(() => parseMacHello({ t: "refused", reason: "no" })).toThrow();
    expect(parseMacHello({ t: "hello", version: 1, mac: { name: "Mac" }, deviceId: "d", routes: [{ kind: "lan", host: "mac.local", port: 47820 }] })).toBeTruthy();
  });

  describe("a Mac hello's routes", () => {
    const hello = (routes: unknown) => ({ t: "hello", version: 1, mac: { name: "Mac" }, deviceId: "d", routes });
    const lan = { kind: "lan", host: "mac.local", port: 47820 };
    const tailnet = { kind: "tailnet", host: "100.64.0.7", port: 47820 };
    const cloud = { kind: "public", host: "sb-abc.vercel.run", port: 443 };

    it.each([
      ["lan and tailnet, as before", [lan, tailnet]],
      ["a cloud host's public route", [cloud]],
      ["none, which a Mac may send", []],
    ])("read %s", (_case, routes) => {
      expect(parseMacHello(hello(routes))).toEqual(hello(routes));
    });

    it("drop routes of kinds this build does not know, down to none", () => {
      const relay = { kind: "relay", host: "relay.example.com", port: 1, path: "/r" };
      expect(parseMacHello(hello([relay, tailnet, { kind: "pigeon" }]))).toEqual(hello([tailnet]));
      expect(parseMacHello(hello([relay]))).toEqual(hello([]));
    });

    it.each([
      ["a known route with an extra field", [{ ...lan, path: "/" }]],
      ["a known route on no port", [{ ...cloud, port: 0 }]],
      ["a route without a kind", [lan, { host: "x", port: 1 }]],
      ["a route that is not an object", [lan, "mac.local"]],
      ["routes that are not a list", { lan }],
      ["more than 32 routes", Array.from({ length: 33 }, () => lan)],
    ])("refuse %s", (_case, routes) => {
      expect(() => parseMacHello(hello(routes))).toThrow("not a Mac hello");
    });

    it("refuse a hello without routes", () => {
      const { routes: _routes, ...bare } = hello([lan]);
      expect(() => parseMacHello(bare)).toThrow("not a Mac hello");
    });
  });

  it("check the envelope of Mac messages and leave push bodies to the authenticated Mac", () => {
    expect(parseMacMessage({ t: "push", push: { type: "frame", frame: { runId: "r", seq: 1, events: [] } } })).toBeTruthy();
    expect(parseMacMessage({ t: "closing", reason: "removed" })).toBeTruthy();
    expect(parseMacMessage({ t: "push", push: { type: "preview", threadId: "t", state: { open: false } } })).toBeTruthy();
    expect(parseMacMessage({ t: "push", push: { type: "preview.ended", threadId: "t", message: "This thread is gone." } })).toBeTruthy();
    expect(() => parseMacMessage({ t: "push", push: { type: "log", message: "x" } })).toThrow();
    expect(() => parseMacMessage({ t: "closing", reason: "bored" })).toThrow();
  });
});

describe("the main entry", () => {
  it("imports no Node module and uses no Buffer, so the phone can load it", () => {
    const directory = new URL(".", import.meta.url);
    const sources = readdirSync(directory).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "node.ts");
    expect(sources).toContain("index.ts");
    for (const name of sources) {
      const source = readFileSync(new URL(name, directory), "utf8");
      expect(source, name).not.toMatch(/from "node:|require\(|\bBuffer\b|\bprocess\./);
    }
  });
});
