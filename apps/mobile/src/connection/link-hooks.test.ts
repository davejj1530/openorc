// @vitest-environment jsdom
import { LinkCloseCode } from "@openorc/link";
import type { AssetRef } from "@openorc/protocol";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkHooks } from "./link-hooks";
import { ConnectionManager } from "./manager";
import type { NetworkKind } from "./saved-macs";
import { FakeMac, lan, pairedWith, tailnet } from "./test-fixtures/fake-mac";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/** A phone linked to `mac`, reading a tool call's output the way the tool sheet does. */
function phone(mac: FakeMac, network: NetworkKind) {
  const manager = new ConnectionManager(pairedWith(mac));
  const hooks = linkHooks(manager);
  const read = (key: string) => manager.connection.call("events.toolOutput", JSON.parse(key) as { runId: string; toolCallId: string });
  manager.start(network);
  return { manager, hooks, read };
}

const key = JSON.stringify({ runId: "r", toolCallId: "big" });
/** How many times the Mac was asked for the output. */
const asked = (mac: FakeMac) => mac.heard.filter((message) => message.t === "rpc" && message.method === "events.toolOutput").length;
/** The Mac answers the last call it heard and held. */
function answer(mac: FakeMac, result: unknown) {
  const call = mac.heard.findLast((message) => message.t === "rpc");
  if (call?.t !== "rpc") throw new Error("no call");
  mac.send({ t: "rpc.result", id: call.id, result });
}
/** A Mac that holds every read until `answering` is set. */
function holding(mac: FakeMac) {
  const state = { answering: false };
  mac.answer = (method) => (method === "events.toolOutput" && state.answering ? { output: "11,000 lines" } : undefined);
  return state;
}

describe("useLinkRead", () => {
  it("shows a read the link dropped as failed while the link is down, and reads again, loading, once it is back", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    holding(mac);
    const { hooks, read, manager } = phone(mac, "wifi");
    await advance(10);
    const { result } = renderHook(() => hooks.useLinkRead(key, read));
    await advance(10);
    expect(asked(mac)).toBe(1);

    mac.live[0]!.close(LinkCloseCode.normal);
    await advance(10);
    expect(manager.getState().kind).toBe("waiting");
    expect(result.current).toEqual({ state: "failed" });

    await advance(1_000);
    expect(manager.getState().kind).toBe("connected");
    expect(asked(mac)).toBe(2);
    // The screen shows the read under way again, not the failure it is retrying.
    expect(result.current).toEqual({ state: "loading" });
    answer(mac, { output: "11,000 lines" });
    await advance(10);
    expect(result.current).toEqual({ state: "ready", value: { output: "11,000 lines" } });
  });

  it("lets a read finish on the old session when the phone moves to the LAN, and reads again if that session ends first", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    mac.behave(tailnet, { kind: "answer" });
    const mac$ = holding(mac);
    const { hooks, read, manager } = phone(mac, "cellular");
    await advance(10);
    const { result } = renderHook(() => hooks.useLinkRead(key, read));
    await advance(10);
    manager.setNetwork("wifi");
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "connected", route: lan });
    expect(asked(mac)).toBe(1);

    mac$.answering = true;
    // The tailnet session gives up on the read it still holds after 5 s.
    await advance(5_000);
    expect(result.current).toEqual({ state: "ready", value: { output: "11,000 lines" } });
    expect(asked(mac)).toBe(2);
  });

  it("lets an image download finish on the old session when the phone moves to the LAN", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "answer" });
    mac.behave(tailnet, { kind: "answer" });
    const { hooks, manager } = phone(mac, "cellular");
    const image = (ref: string) => manager.connection.asset(JSON.parse(ref) as AssetRef);
    await advance(10);
    const { result } = renderHook(() => hooks.useLinkRead(JSON.stringify({ kind: "attachment", name: "shot.png" }), image));
    await advance(10);
    manager.setNetwork("wifi");
    await advance(10);
    expect(manager.getState()).toMatchObject({ kind: "connected", route: lan });
    const [tailnetSession] = mac.sessions;
    expect(tailnetSession!.closed).toBe(false);
    expect(result.current).toEqual({ state: "loading" });

    const request = mac.heard.find((message) => message.t === "asset");
    if (request?.t !== "asset") throw new Error("no asset request");
    const bytes = Uint8Array.from([1, 2, 3]);
    tailnetSession!.send({ t: "asset.bytes", id: request.id, mime: "image/png", size: bytes.length });
    void tailnetSession!.sendBytes(request.id, bytes);
    await advance(10);
    expect(result.current).toEqual({ state: "ready", value: { mime: "image/png", bytes } });
    expect(mac.heard.filter((message) => message.t === "asset")).toHaveLength(1);
    expect(tailnetSession!.closed).toBe(true);
  });

  it("reads once a Mac answers when the first read found none", async () => {
    const mac = new FakeMac();
    mac.behave(lan, { kind: "down" });
    holding(mac).answering = true;
    const { hooks, read, manager } = phone(mac, "wifi");
    const { result } = renderHook(() => hooks.useLinkRead(key, read));
    await advance(8_000);
    expect(result.current).toEqual({ state: "failed" });

    mac.behave(lan, { kind: "answer" });
    await advance(16_000);
    expect(manager.getState().kind).toBe("connected");
    expect(result.current).toEqual({ state: "ready", value: { output: "11,000 lines" } });
    expect(asked(mac)).toBe(1);
  });
});
