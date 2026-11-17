import type { Hosted } from "@openorc/hosted";
import { standIn, type StandIn } from "@openorc/hosted/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PhoneCloud, type CloudRecord, type CloudSource } from "./phone-cloud";
import { accountOn, quiet, socket } from "./test-fixtures/stand-in-account";

/*
 * The phone's own OpenOrc Cloud, against the stand-in: it takes a session of its own from the Mac it pairs with, for the
 * person signed in there, and drops it when that person signs out or another signs in.
 */

const RILEY = "riley@example.com";
const MARA = "mara@example.com";

let stand: StandIn;
const hosts: { close(): void }[] = [];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
});
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  await stand.close();
});

/** The Mac's account, signed in as `email`, and the source a phone takes its cloud from. */
async function mac(email: string): Promise<{ hosted: Hosted; source: CloudSource; asked: string[] }> {
  const hosted = await accountOn(stand, email);
  hosts.push(hosted);
  const asked: string[] = [];
  const source: CloudSource = {
    owner: async () => {
      asked.push("owner");
      const status = hosted.account.status();
      return status.state === "signed-in" ? { server: stand.url, email: status.email } : null;
    },
    grant: async (challenge) => {
      asked.push("grant");
      const status = hosted.account.status();
      if (status.state !== "signed-in") throw new Error("Sign in to OpenOrc Cloud on your Mac first.");
      return { server: stand.url, email: status.email, ...(await hosted.account.grantSignIn({ challenge, device: "OpenOrc on iPhone" })) };
    },
  };
  return { hosted, source, asked };
}

/** A phone: its Keychain vault and kept answers, which outlive the cloud the test makes on them, as a relaunch does. */
function phone() {
  const vault = { record: null as CloudRecord | null, saves: 0 };
  const kept = new Map<string, string>();
  const make = () => {
    const cloud = new PhoneCloud({
      vault: {
        load: async () => vault.record,
        save: async (record) => {
          vault.saves++;
          vault.record = record;
        },
      },
      kept: { load: (part) => kept.get(part) ?? null, save: (part, json) => void (json === null ? kept.delete(part) : kept.set(part, json)), forget: () => kept.clear() },
      fetch,
      connect: socket,
      push: () => undefined,
      projects: () => [],
      now: Date.now,
      log: quiet,
    });
    hosts.push(cloud);
    return cloud;
  };
  return { vault, kept, make };
}
const tokenOf = (record: CloudRecord | null) => (record ? (JSON.parse(record.value) as { token?: string }).token : undefined);
const signedInAs = (cloud: PhoneCloud) => {
  const status = cloud.hosted?.account.status();
  return status?.state === "signed-in" ? status.email : null;
};

it("takes a session of its own from its Mac for the person there, keeps it across a relaunch, and asks no more", async () => {
  const studio = await mac(RILEY);
  const device = phone();
  const cloud = device.make();
  await cloud.start();
  await cloud.follow(studio.source);
  await vi.waitFor(() => expect(signedInAs(cloud)).toBe(RILEY));
  expect(device.vault.record?.server).toBe(stand.url);
  expect(tokenOf(device.vault.record)).toBeTruthy();
  cloud.close();
  // A relaunch: the kept session is there before the Mac answers, and following the same person asks only whose it is.
  const again = device.make();
  await again.start();
  await vi.waitFor(() => expect(signedInAs(again)).toBe(RILEY));
  studio.asked.length = 0;
  await again.follow(studio.source);
  expect(studio.asked).toEqual(["owner"]);
});

it("drops its session when the person signs out on the Mac, and takes another person's when another signs in there", async () => {
  const studio = await mac(RILEY);
  const device = phone();
  const cloud = device.make();
  await cloud.follow(studio.source);
  const riley = tokenOf(device.vault.record);
  const session = () => fetch(`${stand.url}/api/auth/get-session`, { headers: { authorization: `Bearer ${riley}` } }).then((answer) => answer.text());
  expect(await session()).toContain(RILEY);
  device.kept.set("threads", "[]");
  await studio.hosted.account.signOut();
  await cloud.follow(studio.source);
  expect(cloud.hosted).toBeNull();
  expect(device.vault.record).toBeNull();
  expect(device.kept.size).toBe(0);
  // Signed out at the server too: the token it held opens nothing now.
  expect(await session()).not.toContain(RILEY);

  const laptop = await mac(MARA);
  await cloud.follow(laptop.source);
  await vi.waitFor(() => expect(signedInAs(cloud)).toBe(MARA));
  expect(tokenOf(device.vault.record)).not.toBe(riley);
});

it("tells a listener that took its subscribe on its own, as a store hook takes it, when its session comes and goes", async () => {
  const studio = await mac(RILEY);
  const cloud = phone().make();
  const { subscribe } = cloud;
  const heard: boolean[] = [];
  subscribe(() => void heard.push(cloud.holds));
  await cloud.follow(studio.source);
  await studio.hosted.account.signOut();
  await cloud.follow(studio.source);
  expect(heard).toContain(true);
  expect(heard.at(-1)).toBe(false);
});

it("keeps its session through a Mac that cannot say whose it is, and one at a time however often it is asked", async () => {
  const studio = await mac(RILEY);
  const device = phone();
  const cloud = device.make();
  await Promise.all([cloud.follow(studio.source), cloud.follow(studio.source), cloud.follow(studio.source)]);
  expect(studio.asked.filter((each) => each === "grant")).toEqual(["grant"]);
  const broken: CloudSource = { owner: () => Promise.reject(new Error("The phone is not connected to its Mac.")), grant: () => Promise.reject(new Error("no")) };
  await expect(cloud.follow(broken)).rejects.toThrow("not connected");
  expect(signedInAs(cloud)).toBe(RILEY);
});
