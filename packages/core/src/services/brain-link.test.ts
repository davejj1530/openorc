import { createServer as createHttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { acceptLink } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import { socketPair } from "@openorc/link/test-fixtures/socket-pair";
import { BrainLink, BrainOutOfReach } from "./brain-link.js";

let server: Server | null = null;
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = null;
});

it("gives up on a brain whose address takes the connection and never answers, as out of reach", async () => {
  server = createServer((socket) => void sockets.push(socket));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const keys = { publicKey: new Uint8Array(32), privateKey: new Uint8Array(32) };
  const link = new BrainLink({
    endpoint: {
      ready: async () => true,
      locate: async () => ({ url: `ws://127.0.0.1:${port}/link`, brainKey: new Uint8Array(32), ownerKeys: keys }),
      wake: async () => {},
      projects: async () => ({ toCloud: () => null, toMac: () => null }),
    },
    log: { info: () => {}, warn: () => {}, error: () => {} } as never,
    connectMs: 200,
  });
  await expect(link.call("threads.list", {}, { wake: false })).rejects.toThrow("can't be reached");
  expect(link.reach).toBe("offline");
  link.close();
});

it("keeps saying it wakes the brain until the wake ends, though a dial meanwhile finds its address not answering yet", async () => {
  server = createHttpServer();
  let upgrades = 0;
  // A sleeping brain's address refuses the upgrade, as Vercel's proxy does with 502.
  server.on("upgrade", (_request, socket) => {
    upgrades++;
    socket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const keys = { publicKey: new Uint8Array(32), privateKey: new Uint8Array(32) };
  let woke: () => void = () => undefined;
  const link = new BrainLink({
    endpoint: {
      ready: async () => true,
      locate: async () => ({ url: `ws://127.0.0.1:${port}/link`, brainKey: new Uint8Array(32), ownerKeys: keys }),
      wake: () => new Promise<void>((resolve) => (woke = resolve)),
      projects: async () => ({ toCloud: () => null, toMac: () => null }),
    },
    log: { info: () => {}, warn: () => {}, error: () => {} } as never,
    connectMs: 2_000,
  });
  const reaches: string[] = [];
  link.onReach((reach) => reaches.push(reach));
  const opening = link.call("events.page", { runId: "run" } as never, { wake: true });
  await vi.waitFor(() => expect(link.reach).toBe("waking"));
  const dialed = upgrades;
  const meanwhile = link.call("threads.list", {}, { wake: false });
  await vi.waitFor(() => expect(upgrades).toBe(dialed + 1));
  expect(link.reach).toBe("waking");
  expect(reaches.slice(reaches.indexOf("waking"))).toEqual(["waking"]);
  woke();
  await expect(opening).rejects.toThrow(BrainOutOfReach);
  await expect(meanwhile).rejects.toThrow(BrainOutOfReach);
  expect(link.reach).toBe("asleep");
  link.close();
});

it("wakes the brain once, and keeps one session with it, however many calls waited for the wake", async () => {
  const brainKeys = nodeCrypto.generateKeyPair();
  let awake = false;
  let sessions = 0;
  const dial = async () => {
    if (!awake) throw new Error("connect ECONNREFUSED");
    const { phone, mac } = socketPair();
    void acceptLink({ socket: mac, crypto: nodeCrypto, local: brainKeys, admit: () => ({ ok: true, value: null, hello: { mac: { name: "Cloud" }, deviceId: "owner", routes: [] } }) }).then(
      (accepted) => {
        if (!accepted) return;
        sessions++;
        accepted.session.onMessage((message) => {
          if (message.t === "rpc") accepted.session.send({ t: "rpc.result", id: message.id, result: null });
        });
      },
    );
    return phone;
  };
  let wakes = 0;
  let woke: () => void = () => undefined;
  const link = new BrainLink({
    endpoint: {
      ready: async () => true,
      locate: async () => ({ url: "ws://brain/link", brainKey: brainKeys.publicKey, ownerKeys: nodeCrypto.generateKeyPair() }),
      wake: () => {
        wakes++;
        return new Promise<void>((resolve) => (woke = resolve));
      },
      projects: async () => ({ toCloud: () => null, toMac: () => null }),
    },
    log: { info: () => {}, warn: () => {}, error: () => {} } as never,
    dial,
  });
  const calls = Promise.all([
    link.call("runs.listForThread", { threadId: "thread" }, { wake: true }),
    link.call("events.page", { runId: "run" } as never, { wake: true }),
    link.call("threads.get", { id: "thread" }, { wake: true }),
  ]);
  await vi.waitFor(() => expect(link.reach).toBe("waking"));
  // The brain came up on its own meanwhile, and the link's own dial found it first.
  awake = true;
  link.start();
  await vi.waitFor(() => expect(sessions).toBe(1));
  woke();
  await calls;
  expect(wakes).toBe(1);
  expect(sessions).toBe(1);
  expect(link.reach).toBe("live");
  link.close();
});

it("has a call that may not wake the brain wait for a wake under way, and answer once the brain is up", async () => {
  const brainKeys = nodeCrypto.generateKeyPair();
  let awake = false;
  const dial = async () => {
    if (!awake) throw new Error("connect ECONNREFUSED");
    const { phone, mac } = socketPair();
    void acceptLink({ socket: mac, crypto: nodeCrypto, local: brainKeys, admit: () => ({ ok: true, value: null, hello: { mac: { name: "Cloud" }, deviceId: "owner", routes: [] } }) }).then(
      (accepted) => accepted?.session.onMessage((message) => message.t === "rpc" && accepted.session.send({ t: "rpc.result", id: message.id, result: message.method })),
    );
    return phone;
  };
  let wakes = 0;
  let woke: () => void = () => undefined;
  const link = new BrainLink({
    endpoint: {
      ready: async () => true,
      locate: async () => ({ url: "ws://brain/link", brainKey: brainKeys.publicKey, ownerKeys: nodeCrypto.generateKeyPair() }),
      wake: () => {
        wakes++;
        return new Promise<void>((resolve) => (woke = resolve));
      },
      projects: async () => ({ toCloud: () => null, toMac: () => null }),
    },
    log: { info: () => {}, warn: () => {}, error: () => {} } as never,
    dial,
  });
  const opening = link.call("threads.messages", { id: "thread" }, { wake: true });
  await vi.waitFor(() => expect(link.reach).toBe("waking"));
  const following = link.call("events.page", { runId: "run" } as never, { wake: false });
  awake = true;
  woke();
  expect(await Promise.all([opening, following])).toEqual(["threads.messages", "events.page"]);
  expect(wakes).toBe(1);
  link.close();
});

it("never dials a brain whose address would wake it while it sleeps, and dials it after a wake", async () => {
  const brainKeys = nodeCrypto.generateKeyPair();
  let dials = 0;
  const dial = async () => {
    dials++;
    const { phone, mac } = socketPair();
    void acceptLink({ socket: mac, crypto: nodeCrypto, local: brainKeys, admit: () => ({ ok: true, value: null, hello: { mac: { name: "Cloud" }, deviceId: "owner", routes: [] } }) }).then(
      (accepted) => accepted?.session.onMessage((message) => message.t === "rpc" && accepted.session.send({ t: "rpc.result", id: message.id, result: message.method })),
    );
    return phone;
  };
  let wakes = 0;
  const link = new BrainLink({
    endpoint: {
      ready: async () => true,
      locate: async () => ({ url: "ws://brain/link", brainKey: brainKeys.publicKey, ownerKeys: nodeCrypto.generateKeyPair() }),
      // Its machine says it is asleep, and a status read is all it takes to know.
      dialable: async () => false,
      wake: async () => void wakes++,
      projects: async () => ({ toCloud: () => null, toMac: () => null }),
    },
    log: { info: () => {}, warn: () => {}, error: () => {} } as never,
    retryMs: 20,
    dial,
  });
  link.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  link.awoke();
  await expect(link.call("threads.list", {}, { wake: false })).rejects.toThrow(BrainOutOfReach);
  expect([dials, link.reach]).toEqual([0, "asleep"]);
  expect(await link.call("threads.get", { id: "thread" }, { wake: true })).toBe("threads.get");
  expect([dials, wakes, link.reach]).toEqual([1, 1, "live"]);
  link.close();
});
