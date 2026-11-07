import { doorLine, knockInWindow, knockProves, readKnock, toBase64Url } from "@openorc/link";
import { nobleCrypto } from "@openorc/link/test-fixtures/noble-crypto";
import type { DoorKey } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { phoneDoors, streamLines, type DoorKeyStore, type DoorPost, type DoorResponse } from "./door";

beforeEach(() => void vi.useFakeTimers({ now: 1_762_000_000_000 }));
afterEach(() => void vi.useRealTimers());

const HOST = "openorc-door-abcdefghijklmnop.vercel.app";
const TICKET = Uint8Array.from({ length: 32 }, (_, i) => i);
const KEY: DoorKey = { host: HOST, device: "phone-1", epoch: 685, ticket: toBase64Url(TICKET) };
const READY = { state: "ready", route: { kind: "public", host: "sb-brain.vercel.run", port: 443 } } as const;
const clock = {
  now: () => Date.now(),
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function memoryKeys(): DoorKeyStore & { saved: Map<string, string> } {
  const saved = new Map<string, string>();
  return { saved, read: async (id) => saved.get(id) ?? null, write: async (id, value) => void saved.set(id, value), remove: async (id) => void saved.delete(id) };
}

function answer(status: number, body: string[] | string, options: { cutAfter?: number } = {}): DoorResponse {
  const lines = typeof body === "string" ? body.split("\n") : body;
  return {
    status,
    text: async () => (typeof body === "string" ? body : body.join("\n")),
    lines: async function* () {
      for (const [index, line] of lines.entries()) {
        if (options.cutAfter === index) throw new Error("The network connection was lost.");
        yield line;
      }
    },
  };
}

/** A door that checks each knock against the phone's ticket the way a real one does, then answers as told. */
function door(reply: (knock: { at: number }) => DoorResponse | Promise<DoorResponse>) {
  const knocks: { url: string; at: number; proves: boolean }[] = [];
  const post: DoorPost = async (url, { body }) => {
    const read = readKnock(JSON.parse(body));
    if (read.kind !== "knock") throw new Error("not a knock");
    knocks.push({ url, at: read.knock.at, proves: knockProves(nobleCrypto, read.knock, { host: HOST, ticket: TICKET }) });
    return reply(read.knock);
  };
  return { post, knocks };
}

const accepted = doorLine({ t: "accepted" }).trim();
const done = (outcome: unknown) => JSON.stringify({ t: "done", outcome });

async function knockWith(post: DoorPost, keys = memoryKeys()) {
  const doors = phoneDoors({ crypto: nobleCrypto, clock, post, keys });
  await doors.learn("cloud", KEY);
  return doors.knock("cloud", new AbortController().signal);
}

describe("a phone's doors", () => {
  it("keeps each host's key in the Keychain store, and forgets it for a host with none", async () => {
    const keys = memoryKeys();
    const doors = phoneDoors({ crypto: nobleCrypto, clock, post: door(() => answer(404, "")).post, keys });
    expect(await doors.has("cloud")).toBe(false);
    await doors.learn("cloud", { ...KEY, extra: "dropped" } as DoorKey);
    expect(JSON.parse(keys.saved.get("cloud")!)).toEqual(KEY);
    expect(await doors.has("cloud")).toBe(true);
    expect(await phoneDoors({ crypto: nobleCrypto, clock, post: door(() => answer(404, "")).post, keys }).has("cloud")).toBe(true);
    await doors.learn("cloud", null);
    expect(keys.saved.has("cloud")).toBe(false);
    expect(await doors.has("cloud")).toBe(false);
    await doors.learn("cloud", { ...KEY, ticket: "short" });
    expect(await doors.has("cloud")).toBe(false);
    await doors.learn("cloud", KEY);
    await doors.forget("cloud");
    expect(keys.saved.size).toBe(0);
    expect(await doors.has("cloud")).toBe(false);
  });

  it("knocks with a proof the door takes, at the door's path, and hears the route once the host is ready", async () => {
    const { post, knocks } = door(() => answer(200, [accepted, "", "", done(READY)]));
    expect(await knockWith(post)).toEqual({ kind: "ready", route: READY.route });
    expect(knocks).toEqual([{ url: `https://${HOST}/api/door`, at: Date.now(), proves: true }]);
  });

  it("reads a host that did not start, a stream that ends or is cut without done, or a state it does not know, as failed", async () => {
    expect(await knockWith(door(() => answer(200, [accepted, done({ state: "failed" })])).post)).toEqual({ kind: "failed" });
    expect(await knockWith(door(() => answer(200, [accepted, "", ""])).post)).toEqual({ kind: "failed" });
    expect(await knockWith(door(() => answer(200, [accepted, "", "", done(READY)], { cutAfter: 2 })).post)).toEqual({ kind: "failed" });
    expect(await knockWith(door(() => answer(200, [accepted, done({ state: "dreaming" })])).post)).toEqual({ kind: "failed" });
    expect(await knockWith(door(() => answer(502, "Bad gateway")).post)).toEqual({ kind: "failed" });
  });

  it("leaves to the Mac a ticket too old, a door too old, or a host that needs setting up", async () => {
    for (const why of ["expired", "door-outdated", "needs-mac"])
      expect(await knockWith(door(() => answer(403, doorLine({ t: "refused", why: why as "expired", now: Date.now() }))).post)).toEqual({ kind: "needs-mac" });
    expect(await knockWith(door(() => answer(200, [accepted, done({ state: "needs-mac", why: "vercel" })])).post)).toEqual({ kind: "needs-mac" });
  });

  it("hears nothing from a host without a door, or with no way to it", async () => {
    expect(await knockWith(door(() => answer(404, "The deployment could not be found")).post)).toEqual({ kind: "unanswered" });
    expect(await knockWith(door(() => answer(403, "<html>Log in to Vercel</html>")).post)).toEqual({ kind: "unanswered" });
    expect(await knockWith(door(() => answer(200, ["<html>", "</html>"])).post)).toEqual({ kind: "unanswered" });
    expect(await knockWith(door(() => Promise.reject(new Error("The Internet connection appears to be offline."))).post)).toEqual({ kind: "unanswered" });
    const doors = phoneDoors({ crypto: nobleCrypto, clock, post: () => expect.unreachable(), keys: memoryKeys() });
    expect(await doors.knock("cloud", new AbortController().signal)).toEqual({ kind: "unanswered" });
  });

  it("signs once more on the door's clock when its own is off, and no more", async () => {
    const doorNow = Date.now() + 10 * 60_000;
    const { post, knocks } = door((knock) => (knockInWindow(knock, doorNow) ? answer(200, [accepted, done(READY)]) : answer(403, doorLine({ t: "refused", why: "denied", now: doorNow }))));
    expect(await knockWith(post)).toEqual({ kind: "ready", route: READY.route });
    expect(knocks.map((knock) => knock.at - Date.now())).toEqual([0, 10 * 60_000]);

    const denied = door(() => answer(403, doorLine({ t: "refused", why: "denied", now: doorNow })));
    expect(await knockWith(denied.post)).toEqual({ kind: "refused" });
    expect(denied.knocks).toHaveLength(2);
    const near = door(() => answer(403, doorLine({ t: "refused", why: "denied", now: Date.now() + 5_000 })));
    expect(await knockWith(near.post)).toEqual({ kind: "refused" });
    expect(near.knocks).toHaveLength(1);
    expect(await knockWith(door(() => answer(403, JSON.stringify({ t: "refused", why: "moon", now: 1 }))).post)).toEqual({ kind: "failed" });
  });

  it("stops waiting once the phone moves on, or after three minutes", async () => {
    const hung: DoorPost = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const doors = phoneDoors({ crypto: nobleCrypto, clock, post: hung, keys: memoryKeys() });
    await doors.learn("cloud", KEY);
    const moved = new AbortController();
    const first = doors.knock("cloud", moved.signal);
    moved.abort();
    expect(await first).toEqual({ kind: "unanswered" });
    const second = doors.knock("cloud", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await second).toEqual({ kind: "unanswered" });
  });
});

describe("a streamed body", () => {
  it("comes out a line at a time, however its chunks fall", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of ['{"t":"acc', 'epted"}\n\n', "\n", '{"t":"done"}']) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const lines: string[] = [];
    for await (const line of streamLines(body)) lines.push(line);
    expect(lines).toEqual(['{"t":"accepted"}', "", "", '{"t":"done"}']);
    for await (const line of streamLines(null)) lines.push(line);
    expect(lines).toHaveLength(4);
  });
});
