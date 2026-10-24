import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { decodePairingUrl } from "@openorc/link";
import { OpenOrc } from "../openorc.js";
import { RemoteTestClient } from "./test-client.js";

const machine = { name: () => "Test Mac", lanHosts: () => ["127.0.0.1"], tailnetHosts: async () => [] };

it("ends phone sessions when turned off, and comes back on the same port with the same key", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-remote-toggle-"));
  let saved: string | null = null;
  const core = await OpenOrc.create({
    dataDir,
    ephemeral: true,
    transport: { push() {} },
    remoteSecrets: {
      load: async () => saved,
      save: async (value) => {
        saved = value;
      },
    },
    remoteNetwork: { port: 0, machine },
  });
  try {
    await core.remote.attach((request) => core.handle(request));
    expect((await core.remote.status()).listener).toEqual({ state: "off" });
    await core.remote.configure(true);
    const before = decodePairingUrl((await core.remote.beginPairing()).url);
    const phone = await RemoteTestClient.pair((await core.remote.beginPairing()).url);
    if (typeof phone === "string") throw new Error(phone);

    const off = await core.remote.configure(false);
    expect(off.listener).toEqual({ state: "off" });
    expect(off.pairing).toBeNull();
    await phone.until(() => phone.closed);
    expect(phone.closing).toBe("disabled");
    await expect(core.remote.beginPairing()).rejects.toThrow("Turn on phone access first.");

    const on = await core.remote.configure(true);
    expect(on.listener).toMatchObject({ state: "on", port: before.routes[0]!.port });
    const after = decodePairingUrl((await core.remote.beginPairing()).url);
    expect(after.macKey).toEqual(before.macKey);
    const again = await RemoteTestClient.connect({ route: after.routes[0]!, macKey: after.macKey, device: phone.device });
    if (typeof again === "string") throw new Error(again);
    expect(await again.call("projects.list", {})).toBeInstanceOf(Array);
    again.close();
  } finally {
    await core.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

it("reports why phone access cannot turn on without protected storage", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "openorc-remote-nostore-"));
  const core = await OpenOrc.create({ dataDir, ephemeral: true, transport: { push() {} }, remoteNetwork: { port: 0, machine } });
  try {
    await core.remote.attach((request) => core.handle(request));
    const status = await core.remote.configure(true);
    expect(status.listener).toEqual({ state: "failed", reason: expect.stringContaining("protected storage") });
  } finally {
    await core.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
