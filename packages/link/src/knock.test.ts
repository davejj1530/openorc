import { describe, expect, it } from "vitest";
import { toBase64Url } from "./bytes.js";
import { doorLine, doorTicket, knockBody, knockInWindow, knockProves, readDoorLine, readDoorRefusal, readKnock, type DoorTicket, type Knock } from "./knock.js";
import { nodeCrypto } from "./node.js";
import { nobleCrypto } from "./test-fixtures/noble-crypto.js";

const HOST = "openorc-door-abcdefghijklmnop.vercel.app";
const key: DoorTicket = { host: HOST, device: "8b0c1d4e-0000-4000-8000-000000000001", epoch: 685, ticket: Uint8Array.from({ length: 32 }, (_, i) => i) };
const AT = 1_762_000_000_000;

function knocked(body: string): Knock {
  const read = readKnock(JSON.parse(body));
  if (read.kind !== "knock") throw new Error(`not a knock: ${read.kind}`);
  return read.knock;
}

describe("a knock", () => {
  it("signed on the phone's crypto proves at a door on the host's crypto, with the same ticket and host", () => {
    const knock = knocked(knockBody(nobleCrypto, key, AT));
    expect(knock).toMatchObject({ device: key.device, epoch: key.epoch, at: AT });
    expect(knockProves(nodeCrypto, knock, { host: HOST, ticket: key.ticket })).toBe(true);
  });

  // The wire between a phone and a door deployed months apart; the proof was computed apart, in Python.
  it("keeps its signed text stable", () => {
    const fixed = { ...nodeCrypto, randomBytes: (length: number) => new Uint8Array(length).fill(7) };
    const body = JSON.parse(knockBody(fixed, key, AT)) as Record<string, unknown>;
    expect(body).toEqual({ v: 1, device: key.device, epoch: 685, at: AT, nonce: toBase64Url(new Uint8Array(16).fill(7)), proof: "y6-X6gcztYJHhSlzdVka4Af9lgEN6J4qODd--bP539Q" });
  });

  it("does not prove under another ticket, at another host, or with any signed field changed", () => {
    const body = JSON.parse(knockBody(nodeCrypto, key, AT)) as Record<string, unknown>;
    const knock = knocked(JSON.stringify(body));
    const other = Uint8Array.from(key.ticket, (byte, i) => (i === 0 ? byte ^ 1 : byte));
    expect(knockProves(nodeCrypto, knock, { host: HOST, ticket: other })).toBe(false);
    expect(knockProves(nodeCrypto, knock, { host: "openorc-door-ponmlkjihgfedcba.vercel.app", ticket: key.ticket })).toBe(false);
    const changed: Record<string, unknown>[] = [
      { device: "8b0c1d4e-0000-4000-8000-000000000002" },
      { epoch: 686 },
      { at: AT + 1 },
      { nonce: toBase64Url(new Uint8Array(16)) },
      { proof: toBase64Url(new Uint8Array(32)) },
    ];
    for (const change of changed) expect(knockProves(nodeCrypto, knocked(JSON.stringify({ ...body, ...change })), { host: HOST, ticket: key.ticket })).toBe(false);
  });

  it("is read only in exactly its shape, and a newer one is told apart from a foreign body", () => {
    const body = JSON.parse(knockBody(nodeCrypto, key, AT)) as Record<string, unknown>;
    const { nonce: _nonce, ...missing } = body;
    expect(readKnock(body).kind).toBe("knock");
    expect(readKnock({ ...body, v: 2 })).toEqual({ kind: "newer" });
    for (const foreign of [
      null,
      "knock",
      [],
      { ...body, extra: 1 },
      missing,
      { ...body, v: 0 },
      { ...body, device: "a\nb" },
      { ...body, at: -1 },
      { ...body, nonce: toBase64Url(new Uint8Array(15)) },
      { ...body, proof: "not base64!" },
    ])
      expect(readKnock(foreign)).toEqual({ kind: "unreadable" });
  });

  it("holds within 90 s of the door's clock either way, and not a millisecond past", () => {
    expect(knockInWindow({ at: AT }, AT + 90_000)).toBe(true);
    expect(knockInWindow({ at: AT }, AT - 90_000)).toBe(true);
    expect(knockInWindow({ at: AT }, AT + 90_001)).toBe(false);
    expect(knockInWindow({ at: AT }, AT - 90_001)).toBe(false);
  });
});

describe("a door key", () => {
  it("becomes a ticket only when the host gave one this build can sign with", () => {
    const wire = { host: HOST, device: key.device, epoch: key.epoch, ticket: toBase64Url(key.ticket) };
    expect(doorTicket(wire)).toEqual(key);
    expect(doorTicket({ ...wire, ticket: toBase64Url(new Uint8Array(31)) })).toBeNull();
    expect(doorTicket({ ...wire, ticket: "%%" })).toBeNull();
    expect(doorTicket({ ...wire, device: "a b" })).toBeNull();
    expect(doorTicket({ ...wire, epoch: -1 })).toBeNull();
    expect(doorTicket({ ...wire, host: "Door.example/evil" })).toBeNull();
  });
});

describe("the door's answer, as a phone reads it", () => {
  const route = { kind: "public", host: "sb-abc.vercel.run", port: 443 } as const;

  it("reads its own lines back", () => {
    expect(readDoorLine(doorLine({ t: "accepted" }).trim())).toEqual({ t: "accepted" });
    for (const outcome of [{ state: "ready", route }, { state: "needs-mac", why: "vercel" }, { state: "failed" }] as const)
      expect(readDoorLine(doorLine({ t: "done", outcome }).trim())).toEqual({ t: "done", outcome });
    expect(readDoorRefusal(doorLine({ t: "refused", why: "expired", now: AT }))).toEqual({ t: "refused", why: "expired", now: AT });
  });

  it("reads a done it does not know, or a ready without a public route, as failed", () => {
    expect(readDoorLine(JSON.stringify({ t: "done", outcome: { state: "asleep-forever" } }))).toEqual({ t: "done", outcome: { state: "failed" } });
    expect(readDoorLine(JSON.stringify({ t: "done", outcome: { state: "ready", route: { ...route, kind: "lan" } } }))).toEqual({ t: "done", outcome: { state: "failed" } });
    expect(readDoorLine(JSON.stringify({ t: "done", outcome: { state: "needs-mac", why: "moon" } }))).toEqual({ t: "done", outcome: { state: "failed" } });
    expect(readDoorLine(JSON.stringify({ t: "done" }))).toEqual({ t: "done", outcome: { state: "failed" } });
  });

  it("skips keepalives and lines it does not know", () => {
    for (const line of ["", "<html>", JSON.stringify({ t: "progress" }), "[]"]) expect(readDoorLine(line)).toBeNull();
  });

  it("reads a refusal a later door adds to, and one whose reason it does not know as unknown", () => {
    expect(readDoorRefusal(JSON.stringify({ t: "refused", why: "denied", now: AT, retryAfter: 60 }))).toEqual({ t: "refused", why: "denied", now: AT });
    expect(readDoorRefusal(JSON.stringify({ t: "refused", why: "moon", now: AT }))).toEqual({ t: "refused", why: "unknown", now: AT });
  });

  it("knows no refusal in a body that is not one", () => {
    for (const body of ["", "nope", "<html>Log in</html>", JSON.stringify({ t: "refused", why: "denied" }), JSON.stringify({ error: { code: "forbidden" } })]) expect(readDoorRefusal(body)).toBeNull();
  });
});
