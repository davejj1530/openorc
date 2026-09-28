import { afterEach, describe, expect, it, vi } from "vitest";
import { newDevice, relayRequest, relayUrl, SlackRelay, type RelayJournal } from "./relay.js";

const mention = (id: string, user = "UALICE", extra = {}) => ({ event_id: id, team_id: "TTEAM", event: { type: "app_mention", user, channel: "CTEST", ts: "1.0", text: "<@UBOT> hello", ...extra } });
const closers: SlackRelay[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((r) => r.close()));
});
async function fixture(progress?: (job: import("./relay.js").SlackJob, text: string, ts?: string) => Promise<string>) {
  const alice = newDevice("UALICE", "Alice");
  const bob = newDevice("UBOB", "Bob");
  let devices = [alice.device, bob.device];
  const seen = new Set<string>();
  const post = vi.fn(async () => {});
  let journal: RelayJournal = { jobs: [], completed: {} };
  let now = 20_000;
  const create = () =>
    new SlackRelay({
      workspaceId: "TTEAM",
      botId: "UBOT",
      devices: () => devices,
      post,
      progress,
      admit: (id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      },
      now: () => now,
      journal: {
        read: () => structuredClone(journal),
        write: (value) => {
          journal = structuredClone(value);
        },
      },
    });
  const relay = create();
  closers.push(relay);
  const url = `http://127.0.0.1:${await relay.listen(0)}`;
  const request = (key: string, route: "poll" | "result", body = {}) => relayRequest(url, key, route, body);
  return {
    relay,
    create,
    url,
    alice,
    bob,
    post,
    request,
    advance: (ms: number) => {
      now += ms;
    },
    offline: () => {
      now += 20_000;
    },
    revoke: () => {
      devices = [bob.device];
      relay.remove(alice.device.id);
    },
  };
}

describe("Slack POC relay", () => {
  it.each(["message_not_found"])("delivers a final answer once when the progress message cannot be updated (%s)", async (code) => {
    const progress = vi.fn(async (_job: unknown, _text: string, _ts?: string) => "2.0");
    const f = await fixture(progress);
    await f.request(f.alice.deviceKey, "poll");
    await f.relay.receive(mention("UNEDITABLE"));
    await f.request(f.alice.deviceKey, "result", { id: "UNEDITABLE", kind: "progress", text: "Working" });
    progress.mockRejectedValue(Object.assign(new Error("SDK detail must stay private"), { data: { error: code } }));
    const result = { id: "UNEDITABLE", kind: "finished", text: "The completed answer" };
    await f.request(f.alice.deviceKey, "result", result);
    await f.request(f.alice.deviceKey, "result", result);
    expect(f.post.mock.calls.filter((args) => JSON.stringify(args).includes("The completed answer"))).toHaveLength(1);
    expect(await f.request(f.alice.deviceKey, "poll")).toMatchObject({ job: null });
  });
  it("follows owner replies after a mention, retaining other participants as context without running their instructions", async () => {
    const f = await fixture();
    await f.request(f.alice.deviceKey, "poll");
    await f.request(f.bob.deviceKey, "poll");
    await f.relay.receive(mention("START"));
    await f.request(f.alice.deviceKey, "result", { id: "START", kind: "finished", text: "Which model?" });
    await f.relay.receive(mention("BOB", "UBOB", { type: "message", ts: "2.0", thread_ts: "1.0", text: "The project has a README" }));
    expect(await f.request(f.bob.deviceKey, "poll")).toMatchObject({ job: null });
    await f.relay.receive(mention("FOLLOW", "UALICE", { type: "message", ts: "3.0", thread_ts: "1.0", text: "Use GLM please" }));
    expect(await f.request(f.alice.deviceKey, "poll")).toMatchObject({
      job: { id: "FOLLOW", text: "Use GLM please", context: expect.arrayContaining([expect.objectContaining({ userId: "UBOB", text: "The project has a README" })]) },
    });
  });
  it("queues same-thread replies in order, ignores bots/unrelated threads, and deduplicates a completed result after promotion", async () => {
    const f = await fixture();
    await f.request(f.alice.deviceKey, "poll");
    await f.relay.receive(mention("START"));
    await f.relay.receive(mention("BOT", "UALICE", { type: "message", bot_id: "BBOT", thread_ts: "1.0", text: "ignore" }));
    await f.relay.receive(mention("OTHER", "UALICE", { type: "message", thread_ts: "9.0", text: "ignore" }));
    await f.relay.receive(mention("FOLLOW", "UALICE", { type: "message", thread_ts: "1.0", text: "Use GLM please" }));
    await f.relay.receive(mention("FOLLOW", "UALICE", { type: "message", thread_ts: "1.0", text: "Use GLM please" }));
    expect(await f.request(f.alice.deviceKey, "poll")).toMatchObject({ job: { id: "START" } });
    const result = { id: "START", kind: "finished", text: "first answer" };
    await f.request(f.alice.deviceKey, "result", result);
    await f.request(f.alice.deviceKey, "result", result);
    expect(await f.request(f.alice.deviceKey, "poll")).toMatchObject({ job: { id: "FOLLOW", context: expect.arrayContaining([expect.objectContaining({ text: "first answer" })]) } });
    await f.request(f.alice.deviceKey, "result", { id: "FOLLOW", kind: "finished", text: "second answer" });
    await f.relay.close();
    const next = f.create();
    closers.push(next);
    const url = `http://127.0.0.1:${await next.listen(0)}`;
    await relayRequest(url, f.alice.deviceKey, "poll", {});
    await next.receive(mention("AFTER", "UALICE", { type: "message", thread_ts: "1.0", text: "Continue" }));
    expect(await relayRequest(url, f.alice.deviceKey, "poll", {})).toMatchObject({ job: { id: "AFTER" } });
  });
  it("routes two users in the same Slack thread exclusively to their own devices", async () => {
    const f = await fixture();
    await f.request(f.alice.deviceKey, "poll");
    await f.request(f.bob.deviceKey, "poll");
    await Promise.all([f.relay.receive(mention("EA")), f.relay.receive(mention("EB", "UBOB"))]);
    expect(await f.request(f.alice.deviceKey, "poll")).toMatchObject({ userId: "UALICE", job: { id: "EA", userId: "UALICE", threadTs: "1.0" } });
    expect(await f.request(f.bob.deviceKey, "poll")).toMatchObject({ userId: "UBOB", job: { id: "EB", userId: "UBOB" } });
    await expect(f.request(f.bob.deviceKey, "result", { id: "EA", kind: "finished", text: "forged" })).rejects.toThrow("rejected");
    await expect(f.request(f.bob.deviceKey, "poll", { userId: "UALICE" })).rejects.toThrow("rejected");
    await f.request(f.alice.deviceKey, "result", { id: "EA", kind: "finished", text: "Alice reply" });
    expect(f.post).toHaveBeenLastCalledWith(expect.objectContaining({ id: "EA", channelId: "CTEST", threadTs: "1.0" }), "Alice reply");
    expect(await f.request(f.bob.deviceKey, "poll")).toMatchObject({ job: { id: "EB" } });
  });
  it("deduplicates Slack deliveries, repeated polls, and concurrent result retries", async () => {
    const f = await fixture();
    await f.request(f.alice.deviceKey, "poll");
    await Promise.all([f.relay.receive(mention("EA")), f.relay.receive(mention("EA"))]);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(await f.request(f.alice.deviceKey, "poll")).toEqual(await f.request(f.alice.deviceKey, "poll"));
    const body = { id: "EA", kind: "finished", text: "done" };
    await Promise.all([f.request(f.alice.deviceKey, "result", body), f.request(f.alice.deviceKey, "result", body)]);
    await f.request(f.alice.deviceKey, "result", body);
    expect(f.post).toHaveBeenCalledTimes(2);
    await expect(f.request(f.bob.deviceKey, "result", body)).rejects.toThrow("rejected");
    expect(await f.request(f.alice.deviceKey, "poll")).toMatchObject({ job: null });
  });
  it("does not replace busy work and does not queue requests from offline users", async () => {
    const f = await fixture();
    await f.request(f.alice.deviceKey, "poll");
    await f.relay.receive(mention("EA"));
    await f.relay.receive(mention("E2"));
    expect(f.post).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining("already"));
    expect(await f.request(f.alice.deviceKey, "poll")).toMatchObject({ job: { id: "EA" } });
    f.offline();
    await f.relay.receive(mention("EB", "UBOB"));
    expect(f.post).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining("not connected"));
    expect(await f.request(f.bob.deviceKey, "poll")).toMatchObject({ job: null });
  });
  it("rejects invalid and revoked keys and ignores other workspaces, DMs, and bots", async () => {
    const f = await fixture();
    await expect(f.request("wrong", "poll")).rejects.toThrow("rejected");
    await f.request(f.alice.deviceKey, "poll");
    await f.relay.receive(mention("E1", "UALICE", { channel: "DDIRECT" }));
    await f.relay.receive({ ...mention("E2"), team_id: "TOTHER" });
    await f.relay.receive(mention("E3", "UALICE", { bot_id: "BBOT" }));
    await f.relay.receive(mention("E4", "UBOT"));
    await f.relay.receive(mention("E5", "UALICE", { text: "unrelated" }));
    expect(f.post).not.toHaveBeenCalled();
    f.revoke();
    await expect(f.request(f.alice.deviceKey, "poll")).rejects.toThrow("rejected");
  });
  it("retains in-flight correlation across relay restart without replaying an event", async () => {
    const f = await fixture();
    await f.request(f.alice.deviceKey, "poll");
    await f.relay.receive(mention("EA"));
    await f.relay.close();
    const next = f.create();
    closers.push(next);
    const url = `http://127.0.0.1:${await next.listen(0)}`;
    await next.receive(mention("EA"));
    expect(await relayRequest(url, f.alice.deviceKey, "poll", {})).toMatchObject({ job: { id: "EA" } });
    await relayRequest(url, f.alice.deviceKey, "result", { id: "EA", kind: "finished", text: "completed after reconnect" });
    expect(f.post).toHaveBeenCalledTimes(2);
  });
  it("keeps a failed reply available for retry and coalesces waiting notices", async () => {
    const f = await fixture();
    await f.request(f.alice.deviceKey, "poll");
    await f.relay.receive(mention("EA"));
    const wait = { id: "EA", kind: "waiting", text: "ignored" };
    await f.request(f.alice.deviceKey, "result", wait);
    await f.request(f.alice.deviceKey, "result", wait);
    expect(f.post).toHaveBeenCalledTimes(2);
    f.post.mockRejectedValueOnce(new Error("Slack offline"));
    const result = { id: "EA", kind: "finished", text: "done" };
    await expect(f.request(f.alice.deviceKey, "result", result)).rejects.toThrow();
    expect(await f.request(f.alice.deviceKey, "poll")).toMatchObject({ job: { id: "EA" } });
    await f.request(f.alice.deviceKey, "result", result);
    expect(await f.request(f.alice.deviceKey, "poll")).toMatchObject({ job: null });
  });
  it("allows only loopback transport and rejects user-provided URL credentials", () => {
    expect(relayUrl("http://127.0.0.1:47831")).toBe("http://127.0.0.1:47831");
    for (const url of ["http://192.168.1.1:47831", "http://localhost:47831", "http://x:y@127.0.0.1:47831", "http://127.0.0.1:47831/other", "https://example.com"])
      expect(() => relayUrl(url)).toThrow();
  });
});

it("coalesces progress, preserves its message across restart, and never overwrites a final answer with late progress", async () => {
  const progress = vi.fn(async (_job: unknown, _text: string, _ts?: string) => "message-ts");
  const f = await fixture(progress);
  await f.request(f.alice.deviceKey, "poll");
  await f.request(f.bob.deviceKey, "poll");
  await f.relay.receive(mention("STREAM"));
  const update = (text: string) => ({ id: "STREAM", kind: "progress", text });
  await expect(f.request(f.bob.deviceKey, "result", update("forged"))).rejects.toThrow();
  await Promise.all([f.request(f.alice.deviceKey, "result", update("Reading")), f.request(f.alice.deviceKey, "result", update("Reading"))]);
  expect(progress).toHaveBeenCalledTimes(1);
  await f.request(f.alice.deviceKey, "result", update("Reading more"));
  expect(progress).toHaveBeenCalledTimes(1);
  f.advance(2000);
  await f.request(f.alice.deviceKey, "result", update("Reading more"));
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ id: "STREAM" }), "Reading more", "message-ts");
  await f.relay.close();
  const relay = f.create();
  closers.push(relay);
  const url = `http://127.0.0.1:${await relay.listen(0)}`;
  await relayRequest(url, f.alice.deviceKey, "result", { id: "STREAM", kind: "finished", text: "Final answer" });
  expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ id: "STREAM" }), "Final answer", "message-ts");
  await relayRequest(url, f.alice.deviceKey, "result", update("late progress"));
  expect(progress).toHaveBeenCalledTimes(3);
});

it("serves images only from the authenticated device's active job and thread context", async () => {
  const alice = newDevice("UALICE", "Alice");
  const bob = newDevice("UBOB", "Bob");
  const image = vi.fn(async (id: string) => ({ name: id, mime: "image/png", dataBase64: "fixture" }));
  const relay = new SlackRelay({
    workspaceId: "TTEAM",
    botId: "UBOT",
    devices: () => [alice.device, bob.device],
    admit: () => true,
    post: async () => {},
    image,
    history: async () => [{ id: "CTEST:0.0", userId: "UALICE", text: "earlier image", at: 0, files: [{ id: "FHISTORY" }] }],
  });
  closers.push(relay);
  const url = `http://127.0.0.1:${await relay.listen(0)}`;
  await relayRequest(url, alice.deviceKey, "poll", {});
  await relay.receive(mention("IMAGES", "UALICE", { files: [{ id: "FIMAGE" }] }));
  await relayRequest(url, alice.deviceKey, "poll", {});
  await expect(relayRequest(url, bob.deviceKey, "image", { jobId: "IMAGES", fileId: "FIMAGE" })).rejects.toThrow("job no longer matches");
  await expect(relayRequest(url, alice.deviceKey, "image", { jobId: "IMAGES", fileId: "FOTHER" })).rejects.toThrow("rejected");
  expect(image).not.toHaveBeenCalled();
  await expect(relayRequest(url, alice.deviceKey, "image", { jobId: "IMAGES", fileId: "FIMAGE" })).resolves.toMatchObject({ name: "FIMAGE" });
  await expect(relayRequest(url, alice.deviceKey, "image", { jobId: "IMAGES", fileId: "FHISTORY" })).resolves.toMatchObject({ name: "FHISTORY" });
  await relayRequest(url, alice.deviceKey, "result", { id: "IMAGES", kind: "finished", text: "done" });
  await expect(relayRequest(url, alice.deviceKey, "image", { jobId: "IMAGES", fileId: "FIMAGE" })).rejects.toThrow("job no longer matches");
  expect(image).toHaveBeenCalledTimes(2);
});
