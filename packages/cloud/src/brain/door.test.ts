import { describe, expect, it } from "vitest";
import { DOOR_EPOCH_MS, brainDoor, doorEpoch, ticketStanding } from "./door.js";
import { encodeDoorConfig, newBrainKey, readDoorConfig, type BrainKey, type DoorConfig } from "./wire.js";

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i) as BrainKey;
const DEVICE = "8b0c1d4e-0000-4000-8000-000000000001";
const TOKEN = "vcp_7f3k2m9q8w1e4r6t5y0uSECRET";

function config(overrides: Partial<DoorConfig> = {}): DoorConfig {
  return { key: KEY, vercel: { token: TOKEN, teamId: "team_1", project: "openorc-brain" }, name: "Cloud", revoked: [], mark: "m4rk", ...overrides };
}

describe("the brain's door, from its key", () => {
  // The brain issues tickets and the door checks them, each from its own build; the values were computed apart, in Python.
  it("derives a fixed host and fixed tickets from the key", () => {
    const door = brainDoor(KEY);
    expect(door.host).toBe("openorc-door-fqtp2rxccuf6fxv7.vercel.app");
    expect(Buffer.from(door.ticket(DEVICE, 685)).toString("base64url")).toBe("du5obACI0S4rCDo6s7Kj0ivsoPmbGznTt8qbRRJlwdA");
  });

  it("gives another key another host, and every device and epoch its own ticket", () => {
    const door = brainDoor(KEY);
    expect(brainDoor(newBrainKey()).host).toMatch(/^openorc-door-[a-z2-7]{16}\.vercel\.app$/);
    expect(brainDoor(newBrainKey()).host).not.toBe(door.host);
    const tickets = [door.ticket(DEVICE, 685), door.ticket(DEVICE, 686), door.ticket("8b0c1d4e-0000-4000-8000-000000000002", 685), brainDoor(newBrainKey()).ticket(DEVICE, 685)];
    expect(new Set(tickets.map((ticket) => Buffer.from(ticket).toString("hex"))).size).toBe(4);
  });

  it("hands a phone this epoch's ticket for its own device", () => {
    const now = 685 * DOOR_EPOCH_MS + 12_345;
    const door = brainDoor(KEY);
    expect(door.key(DEVICE, now)).toEqual({ host: door.host, device: DEVICE, epoch: 685, ticket: Buffer.from(door.ticket(DEVICE, 685)).toString("base64url") });
  });

  it("takes this epoch's ticket and the last one's, and no older, and none from an epoch not begun", () => {
    const start = 686 * DOOR_EPOCH_MS;
    expect(doorEpoch(start)).toBe(686);
    expect(ticketStanding(686, start)).toBe("good");
    expect(ticketStanding(685, start + DOOR_EPOCH_MS - 1)).toBe("good");
    expect(ticketStanding(685, start + DOOR_EPOCH_MS)).toBe("expired");
    expect(ticketStanding(600, start)).toBe("expired");
    expect(ticketStanding(687, start)).toBe("ahead");
    expect(ticketStanding(687, start + DOOR_EPOCH_MS - 60_000)).toBe("good");
  });

  it("marks a config by everything the door holds and runs, without its text", () => {
    const door = brainDoor(KEY);
    const mark = door.mark("r1", { region: "iad1" }, config());
    expect(mark).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(door.mark("r1", { region: "iad1" }, config())).toBe(mark);
    const others = [
      door.mark("r2", { region: "iad1" }, config()),
      door.mark("r1", { region: "sin1" }, config()),
      door.mark("r1", { region: "iad1" }, config({ vercel: { token: "vcp_other", teamId: "team_1", project: "openorc-brain" } })),
      door.mark("r1", { region: "iad1" }, config({ revoked: [DEVICE] })),
      door.mark("r1", { region: "iad1" }, config({ threadVcpus: 4 })),
      brainDoor(newBrainKey()).mark("r1", { region: "iad1" }, config()),
    ];
    for (const other of others) expect(other).not.toBe(mark);
  });
});

describe("the door's config", () => {
  it("reads back what the Mac wrote", () => {
    expect(readDoorConfig(encodeDoorConfig(config()))).toEqual(config());
    expect(readDoorConfig(encodeDoorConfig(config({ threadVcpus: 4, revoked: [DEVICE] })))).toEqual(config({ threadVcpus: 4, revoked: [DEVICE] }));
  });

  it("is null, never thrown, for none, one it cannot read, or one with more than it knows", () => {
    const written = JSON.parse(encodeDoorConfig(config())) as Record<string, unknown>;
    for (const text of [
      undefined,
      "",
      "{",
      JSON.stringify({ ...written, v: 2 }),
      JSON.stringify({ ...written, extra: 1 }),
      JSON.stringify({ ...written, key: "short" }),
      JSON.stringify({ ...written, revoked: "all" }),
    ])
      expect(readDoorConfig(text)).toBeNull();
  });
});
