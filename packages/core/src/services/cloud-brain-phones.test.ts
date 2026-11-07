import { BrainUnavailable, DOOR_EPOCH_MS, type BrainControlRequest, type BrainPhone } from "@openorc/cloud";
import { Db } from "@openorc/db";
import { expect, it, vi } from "vitest";
import type { BrainMachineLike } from "./cloud-brain-machine.js";
import { BrainPhones, PHONES_FRESH_MS } from "./cloud-brain-phones.js";

const pocket: BrainPhone = { id: "0b6b8a5e-2f4c-4d2a-9c61-1f8e2d3c4b5a", name: "Pocket", createdAt: 1_000, lastSeenAt: 2_000, connected: true };
const tablet: BrainPhone = { id: "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f", name: "Tablet", createdAt: 1_000, lastSeenAt: null, connected: false };

/** The brain as the phones see it: awake or not, answering with the phones it has. Records whether each look woke it. */
function brain() {
  const state = { awake: true, phones: [pocket, tablet], looks: [] as boolean[] };
  const machine = {
    control: async (request: BrainControlRequest) => {
      if (!state.awake) throw new BrainUnavailable();
      if (request.op === "remove-phone") state.phones = state.phones.filter((phone) => phone.id !== request.id);
      return { phones: state.phones };
    },
  } as unknown as BrainMachineLike;
  const phones = new BrainPhones({
    db: Db.memory(),
    machine: async (wake, work) => {
      state.looks.push(wake);
      if (wake) state.awake = true;
      return work(machine);
    },
    changed: () => undefined,
  });
  return { state, phones };
}

const T = 1_800_000_000_000;

it("lists nothing before it heard the brain, then the phones it said, a connected one only while that is fresh", async () => {
  const { phones } = brain();
  expect(phones.list(T)).toEqual([]);
  await vi.waitFor(() => expect(phones.list(T + 1)).toHaveLength(2));
  expect(phones.list(T + 1)).toEqual([{ ...pocket, lastSeenAt: T, connected: true }, tablet]);
  expect(phones.list(T + PHONES_FRESH_MS)).toEqual([{ ...pocket, lastSeenAt: T, connected: false }, tablet]);
});

it("asks a running brain again only once the list is a minute old, sooner while a pairing code is out, and never wakes it", async () => {
  const { state, phones } = brain();
  await phones.ask(T);
  state.looks = [];
  phones.list(T + 1_000);
  phones.list(T + 30_000);
  expect(state.looks).toEqual([]);
  phones.list(T + PHONES_FRESH_MS);
  phones.list(T + PHONES_FRESH_MS + 1_000);
  expect(state.looks).toEqual([false]);

  await vi.waitFor(() => expect(phones.list(T + PHONES_FRESH_MS + 2_000)[0]!.lastSeenAt).toBe(T + PHONES_FRESH_MS));
  const heard = T + PHONES_FRESH_MS;
  state.looks = [];
  phones.list(heard + 12_000);
  expect(state.looks).toEqual([]);
  phones.pairing(heard + 120_000);
  phones.list(heard + 12_000);
  expect(state.looks).toEqual([false]);
});

it("keeps the last list while the brain sleeps, and unpairs a phone by waking it", async () => {
  const { state, phones } = brain();
  await phones.ask();
  state.awake = false;
  await phones.ask();
  expect(phones.list()).toHaveLength(2);
  expect(state.awake).toBe(false);
  expect(await phones.remove(pocket.id)).toEqual([tablet]);
  expect(state.looks.at(-1)).toBe(true);
  expect(state.phones).toEqual([tablet]);
});

it("has the door refuse an unpaired phone while a ticket it got before could hold, then lets the id go", async () => {
  const { phones } = brain();
  const at = Date.now();
  await phones.remove(pocket.id);
  await phones.remove(tablet.id);
  expect(phones.refused(at)).toEqual([pocket.id, tablet.id]);
  expect(phones.refused(at + 2 * DOOR_EPOCH_MS)).toEqual([pocket.id, tablet.id]);
  expect(phones.refused(at + 4 * DOOR_EPOCH_MS)).toEqual([]);
  await phones.remove(pocket.id);
  expect(phones.refused(at)).toEqual([tablet.id, pocket.id]);
  phones.forget();
  expect(phones.refused(at)).toEqual([]);
  expect(phones.list(at)).toEqual([]);
});
