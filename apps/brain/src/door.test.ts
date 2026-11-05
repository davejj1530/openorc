import { VercelRefusal, brainDoor, newBrainKey, type BrainKey, type DoorConfig } from "@openorc/cloud";
import { doorTicket, knockBody, readDoorLine, readDoorRefusal, type DoorOutcome, type DoorTicket } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import { describe, expect, it } from "vitest";
import { doorHandler, wakeThroughDoor, type DoorDeps } from "./door.js";

const KEY = newBrainKey();
const TOKEN = "vcp_7f3k2m9q8w1e4r6t5y0uSECRET";
const DEVICE = "8b0c1d4e-0000-4000-8000-000000000001";
const NOW = 1_762_000_000_000;
const config: DoorConfig = { key: KEY, vercel: { token: TOKEN, teamId: "team_1", project: "openorc-brain" }, name: "Cloud", revoked: [], mark: "m4rk" };
const READY: DoorOutcome = { state: "ready", route: { kind: "public", host: "sb-abc.vercel.run", port: 443 } };

const ticketFor = (key: BrainKey, device = DEVICE, now = NOW): DoorTicket => doorTicket(brainDoor(key).key(device, now))!;

function door(overrides: Partial<DoorDeps> = {}, outcome: () => Promise<DoorOutcome> = async () => READY) {
  const wakes: DoorConfig[] = [];
  const kept: Promise<unknown>[] = [];
  const handler = doorHandler({
    config,
    wake: (given) => {
      wakes.push(given);
      return outcome();
    },
    now: () => NOW,
    waitUntil: (work) => void kept.push(work),
    log: () => undefined,
    keepaliveMs: 5,
    ...overrides,
  });
  const knock = (body: string) => handler(new Request("https://door.example/api/door", { method: "POST", body }));
  return { handler, knock, wakes, kept };
}

async function lines(response: Response): Promise<string[]> {
  return (await response.text()).split("\n").slice(0, -1);
}

describe("a knock at the door", () => {
  it("from a paired phone wakes the brain once, with the door's config, and streams accepted then done", async () => {
    const { knock, wakes, kept } = door();
    const response = await knock(knockBody(nodeCrypto, ticketFor(KEY), NOW));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const read = (await lines(response)).filter(Boolean).map(readDoorLine);
    expect(read).toEqual([{ t: "accepted" }, { t: "done", outcome: READY }]);
    expect(wakes).toEqual([config]);
    expect(kept).toHaveLength(1);
  });

  it("refuses without waking anything: another ticket, another door, a revoked phone, a clock out of the window, an epoch not begun", async () => {
    const other = { ...ticketFor(KEY), ticket: ticketFor(newBrainKey()).ticket };
    const knocks = [
      knockBody(nodeCrypto, other, NOW),
      knockBody(nodeCrypto, ticketFor(newBrainKey()), NOW),
      knockBody(nodeCrypto, { ...ticketFor(KEY), host: "openorc-door-ponmlkjihgfedcba.vercel.app" }, NOW),
      knockBody(nodeCrypto, ticketFor(KEY), NOW - 91_000),
      knockBody(nodeCrypto, ticketFor(KEY), NOW + 91_000),
      knockBody(nodeCrypto, ticketFor(KEY, DEVICE, NOW + 31 * 24 * 3_600_000), NOW),
    ];
    const { knock, wakes } = door({ config: { ...config, revoked: ["8b0c1d4e-0000-4000-8000-00000000dead"] } });
    const revoked = ticketFor(KEY, "8b0c1d4e-0000-4000-8000-00000000dead");
    for (const body of [...knocks, knockBody(nodeCrypto, revoked, NOW)]) {
      const response = await knock(body);
      expect(response.status).toBe(403);
      expect(readDoorRefusal(await response.text())).toEqual({ t: "refused", why: "denied", now: NOW });
    }
    expect(wakes).toEqual([]);
  });

  it("tells a phone whose ticket is too old that it expired, and only when its proof holds", async () => {
    const { knock, wakes } = door();
    const old = ticketFor(KEY, DEVICE, NOW - 61 * 24 * 3_600_000);
    const response = await knock(knockBody(nodeCrypto, old, NOW));
    expect(readDoorRefusal(await response.text())).toEqual({ t: "refused", why: "expired", now: NOW });
    const forged = await knock(knockBody(nodeCrypto, { ...old, ticket: ticketFor(newBrainKey()).ticket }, NOW));
    expect(readDoorRefusal(await forged.text())?.why).toBe("denied");
    expect(wakes).toEqual([]);
  });

  it("says why when only the Mac can help: a door without its config, a phone newer than the door", async () => {
    const bare = door({ config: null });
    expect(readDoorRefusal(await (await bare.knock(knockBody(nodeCrypto, ticketFor(KEY), NOW))).text())?.why).toBe("needs-mac");
    const body = { ...(JSON.parse(knockBody(nodeCrypto, ticketFor(KEY), NOW)) as Record<string, unknown>), v: 2 };
    const outdated = door();
    expect(readDoorRefusal(await (await outdated.knock(JSON.stringify(body))).text())?.why).toBe("door-outdated");
    expect([...bare.wakes, ...outdated.wakes]).toEqual([]);
  });

  it("answers a body that is not a knock with a bare 400", async () => {
    const { knock, wakes } = door();
    for (const body of ["", "{", "[]", JSON.stringify({ knock: true }), knockBody(nodeCrypto, ticketFor(KEY), NOW).replace("}", `,"pad":"${"x".repeat(5000)}"}`)]) {
      const response = await knock(body);
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("");
    }
    expect(wakes).toEqual([]);
  });

  it("keeps the line alive while the brain wakes, then says done", async () => {
    let finish: (outcome: DoorOutcome) => void = () => undefined;
    const { knock } = door({}, () => new Promise((resolve) => (finish = resolve)));
    const response = await knock(knockBody(nodeCrypto, ticketFor(KEY), NOW));
    setTimeout(() => finish({ state: "needs-mac", why: "setup" }), 40);
    const read = await lines(response);
    expect(read[0]).toBe('{"t":"accepted"}');
    expect(read.slice(1, -1).length).toBeGreaterThanOrEqual(3);
    expect(read.slice(1, -1).every((line) => line === "")).toBe(true);
    expect(readDoorLine(read.at(-1)!)).toEqual({ t: "done", outcome: { state: "needs-mac", why: "setup" } });
  });

  it("lets knocks that come while a wake runs join it, and starts another once it is over", async () => {
    let finish: (outcome: DoorOutcome) => void = () => undefined;
    const { knock, wakes } = door({}, () => new Promise((resolve) => (finish = resolve)));
    const first = knock(knockBody(nodeCrypto, ticketFor(KEY), NOW));
    const second = knock(knockBody(nodeCrypto, ticketFor(KEY, "8b0c1d4e-0000-4000-8000-000000000002"), NOW));
    const answers = await Promise.all([first, second]);
    finish(READY);
    for (const answer of answers) expect((await lines(answer)).filter(Boolean).at(-1)).toBe(JSON.stringify({ t: "done", outcome: READY }));
    expect(wakes).toHaveLength(1);
    const third = await knock(knockBody(nodeCrypto, ticketFor(KEY), NOW));
    expect(wakes).toHaveLength(2);
    finish(READY);
    expect((await lines(third)).filter(Boolean).at(-1)).toBe(JSON.stringify({ t: "done", outcome: READY }));
  });

  it("takes a knock once: the same body again is refused, waking nothing, until it leaves the window", async () => {
    let now = NOW;
    const { knock, wakes } = door({ now: () => now });
    const body = knockBody(nodeCrypto, ticketFor(KEY), NOW);
    expect((await knock(body)).status).toBe(200);
    now = NOW + 60_000;
    const again = await knock(body);
    expect(again.status).toBe(403);
    expect(readDoorRefusal(await again.text())).toEqual({ t: "refused", why: "denied", now });
    expect(wakes).toHaveLength(1);
    // A fresh knock from the same phone still wakes it.
    expect((await knock(knockBody(nodeCrypto, ticketFor(KEY), now))).status).toBe(200);
    expect(wakes).toHaveLength(2);
  });

  it("answers GET with its mark only", async () => {
    const answer = await door().handler(new Request("https://door.example/api/door"));
    expect(await answer.json()).toEqual({ door: 1, mark: "m4rk" });
    expect(await (await door({ config: null }).handler(new Request("https://door.example/api/door"))).json()).toEqual({ door: 1, mark: null });
  });
});

describe("the door's wake", () => {
  const found = (result: unknown) => async () => ({ wake: async () => result as never });

  it("is the Mac's wake, with the Mac's inputs, and says where the brain answers", async () => {
    const asked: unknown[] = [];
    const outcome = await wakeThroughDoor(
      { ...config, threadVcpus: 4 },
      () => undefined,
      async (access) => {
        asked.push(access);
        return { wake: async (input) => (asked.push(input), { state: "ready", address: "sb-abc.vercel.run", version: "v1" }) };
      },
    );
    expect(outcome).toEqual(READY);
    expect(asked).toEqual([
      { token: TOKEN, teamId: "team_1", project: "openorc-brain" },
      { key: KEY, name: "Cloud", threadVcpus: 4 },
    ]);
  });

  it("leaves to the Mac a brain that needs setting up, another key, or Vercel refusing the token", async () => {
    const log = () => undefined;
    expect(await wakeThroughDoor(config, log, async () => null)).toEqual({ state: "needs-mac", why: "setup" });
    expect(await wakeThroughDoor(config, log, found({ state: "needs-provision", detail: "gone" }))).toEqual({ state: "needs-mac", why: "setup" });
    expect(await wakeThroughDoor(config, log, found({ state: "wrong-key" }))).toEqual({ state: "needs-mac", why: "key" });
    expect(await wakeThroughDoor(config, log, () => Promise.reject(new VercelRefusal("Not authorized", 403)))).toEqual({ state: "needs-mac", why: "vercel" });
  });

  it("fails a start that did not happen, and logs why without the token or the key", async () => {
    const logged: string[] = [];
    const keyText = Buffer.from(KEY).toString("base64url");
    expect(await wakeThroughDoor(config, (line) => logged.push(line), found({ state: "failed", detail: `start died holding ${TOKEN}` }))).toEqual({ state: "failed" });
    expect(
      await wakeThroughDoor(
        config,
        (line) => logged.push(line),
        () => Promise.reject(new Error(`boom ${keyText}`)),
      ),
    ).toEqual({ state: "failed" });
    expect(logged.join("\n")).toContain("[redacted]");
    expect(logged.join("\n")).not.toContain(TOKEN);
    expect(logged.join("\n")).not.toContain(keyText);
  });
});
