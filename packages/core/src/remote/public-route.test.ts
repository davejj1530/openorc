import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { settings } from "@openorc/db";
import { decodePairingUrl, linkPath, toBase64Url, type LinkSocket } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import { decodePairingUrlAsInstalled, parseMacHelloAsInstalled, rawMacHello } from "@openorc/link/test-fixtures/installed-phone";
import { OpenOrc } from "../openorc.js";
import { listen, type Exposure } from "./listener.js";
import { currentRoutes } from "./routes.js";
import { RemoteTestClient } from "./test-client.js";
import { linkSocket } from "./ws-socket.js";

// Behind a proxy every peer arrives from wherever the proxy runs, which a Mac's filter may well refuse.
vi.mock("./peers.js", () => ({ isLocalPeer: () => false }));

const hostKey = nodeCrypto.generateKeyPair().publicKey;
const proxied: Exposure = { kind: "proxied", path: linkPath("public", hostKey, nodeCrypto) };
const machine = { name: () => "Cloud", lanHosts: () => ["127.0.0.1"], tailnetHosts: async () => [] };

/** What a WebSocket upgrade gets: 101 once the handshake has closed it, another HTTP status, or a reset connection. */
function upgrade(url: string): Promise<number | "reset"> {
  const ws = new WebSocket(url);
  return new Promise((resolve) => {
    ws.once("upgrade", () => ws.once("close", () => resolve(101)));
    ws.once("unexpected-response", (request, response) => {
      resolve(response.statusCode ?? 0);
      request.destroy();
    });
    ws.on("error", () => resolve("reset"));
  });
}

function httpStatus(port: number, at: string): Promise<number> {
  return new Promise((resolve, reject) =>
    httpRequest({ host: "127.0.0.1", port, path: at }, (response) => resolve(response.statusCode ?? 0))
      .on("error", reject)
      .end(),
  );
}

function recordingHandshake() {
  const sources: string[] = [];
  const handshake = async (socket: LinkSocket, source: string) => {
    sources.push(source);
    socket.close(1000, "done");
  };
  return { sources, handshake };
}

describe("a listener behind a TLS proxy", () => {
  it("takes peers a Mac would drop, and upgrades only its tag path", async () => {
    const { sources, handshake } = recordingHandshake();
    const mac = await listen({ port: 0, handshake });
    const cloud = await listen({ port: 0, exposure: proxied, handshake });
    const at = (route: string) => `ws://127.0.0.1:${cloud.port}${route}`;
    try {
      expect(await upgrade(`ws://127.0.0.1:${mac.port}/link/1`)).toBe("reset");
      expect(await httpStatus(cloud.port, proxied.path)).toBe(404);
      expect(await upgrade(at("/link/1"))).toBe(404);
      expect(await upgrade(at(linkPath("public", nodeCrypto.generateKeyPair().publicKey, nodeCrypto)))).toBe(404);
      expect(await upgrade(at(`${proxied.path}/`))).toBe(404);
      expect(sources).toEqual([]);
      expect(await upgrade(at(proxied.path))).toBe(101);
      expect(sources).toEqual(["proxy"]);
    } finally {
      await Promise.all([mac.close(), cloud.close()]);
    }
  });

  it("spends nothing on strangers, and shares one budget of 60 handshakes a minute among holders of the tag", async () => {
    const { sources, handshake } = recordingHandshake();
    const cloud = await listen({ port: 0, exposure: proxied, handshake });
    const at = (route: string) => `ws://127.0.0.1:${cloud.port}${route}`;
    try {
      for (let i = 0; i < 70; i++) expect(await upgrade(at("/link/1"))).toBe(404);
      for (let i = 0; i < 60; i++) expect(await upgrade(at(proxied.path))).toBe(101);
      expect(await upgrade(at(proxied.path))).toBe("reset");
      expect(new Set(sources)).toEqual(new Set(["proxy"]));
    } finally {
      await cloud.close();
    }
  }, 20_000);

  it("listens on exactly its port, and fails rather than move when that port is taken", async () => {
    const { handshake } = recordingHandshake();
    const holder = await listen({ port: 0, handshake });
    try {
      await expect(listen({ port: holder.port, exposure: proxied, handshake })).rejects.toMatchObject({ code: "EADDRINUSE" });
      const mac = await listen({ port: holder.port, handshake });
      expect(mac.port).not.toBe(holder.port);
      await mac.close();
    } finally {
      await holder.close();
    }
  });
});

async function withCloudCore(port: number, run: (core: OpenOrc) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-public-route-"));
  let saved: string | null = null;
  const remoteSecrets = { load: async () => saved, save: async (value: string) => void (saved = value) };
  const core = await OpenOrc.create({ dataDir, ephemeral: true, transport: { push() {} }, remoteSecrets, remoteNetwork: { port, machine, publicAddress: "sb-abc.vercel.run" } });
  try {
    await core.remote.attach((request) => core.handle(request));
    await run(core);
  } finally {
    await core.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function freePort(): Promise<number> {
  const probe = await listen({ port: 0, handshake: async () => {} });
  await probe.close();
  return probe.port;
}

describe("a host with a public address", () => {
  it("is reached only over its public route, listening on the port it was given and saving none", async () => {
    const [port, savedPort] = [await freePort(), await freePort()];
    await withCloudCore(port, async (core) => {
      settings.set(core.db, "remote.access", JSON.stringify({ enabled: false, port: savedPort }));
      const status = await core.remote.configure(true);
      expect(status.listener).toEqual({ state: "on", port, routes: [{ kind: "public", host: "sb-abc.vercel.run", port: 443 }] });
      expect(JSON.parse(settings.get(core.db, "remote.access")!)).toEqual({ enabled: true, port: savedPort });

      const { url } = await core.remote.beginPairing();
      const offer = decodePairingUrl(url);
      expect(offer.routes).toEqual([{ kind: "public", host: "sb-abc.vercel.run", port: 443 }]);
      expect(await upgrade(`ws://127.0.0.1:${port}/link/1`)).toBe(404);
      const phone = await RemoteTestClient.pair(url, { proxyTo: port });
      if (typeof phone === "string") throw new Error(`refused: ${phone}`);
      expect(await phone.call("projects.list", {})).toEqual(expect.any(Array));
      expect(await phone.device("host.kind", {})).toBe("brain");
      phone.close();
    });
  });

  it("speaks a pairing code and a hello that phones already installed read", async () => {
    await withCloudCore(await freePort(), async (core) => {
      const { listener } = await core.remote.configure(true);
      if (listener.state !== "on") throw new Error("not listening");
      const { url } = await core.remote.beginPairing();
      const offer = decodePairingUrlAsInstalled(url);
      expect(offer.routes).toEqual([{ kind: "public", host: "sb-abc.vercel.run", port: 443 }]);
      const ws = new WebSocket(`ws://127.0.0.1:${listener.port}${linkPath("public", offer.macKey, nodeCrypto)}`);
      await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
      const hello = await rawMacHello({
        socket: linkSocket(ws),
        crypto: nodeCrypto,
        device: nodeCrypto.generateKeyPair(),
        macKey: offer.macKey,
        pair: { offerId: offer.offerId, secret: toBase64Url(offer.secret) },
      });
      expect(parseMacHelloAsInstalled(hello)).toMatchObject({ t: "hello", mac: { name: "Cloud" }, routes: offer.routes });
    });
  });

  it("fails to turn on when its port is taken, rather than listen where the proxy does not forward", async () => {
    const holder = await listen({ port: 0, handshake: async () => {} });
    try {
      await withCloudCore(holder.port, async (core) => {
        expect((await core.remote.configure(true)).listener).toEqual({ state: "failed", reason: expect.stringContaining("EADDRINUSE") });
      });
    } finally {
      await holder.close();
    }
  });
});

it("never gives a Mac a public route", async () => {
  const mac = { name: () => "Studio", lanHosts: () => ["studio.local", "192.168.1.20"], tailnetHosts: async () => ["studio.tail1234.ts.net", "100.64.0.7"] };
  expect((await currentRoutes(mac, 47820)).map((route) => route.kind)).toEqual(["lan", "lan", "tailnet", "tailnet"]);
});
