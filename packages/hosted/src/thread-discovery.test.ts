import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { titleFromPrompt } from "@openorc/protocol";
import { z } from "zod";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { keptThreadNames, TITLE_DISCOVERY_MS, TITLE_RETRY_MS } from "./thread-names.js";
import { Threads } from "./threads.js";
import { hostDeps, newDevice, signInAs, type Device } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const SELF = "member@example.com";
const PROMPT = "Add CSV export\nwith filters";
const hosts: Hosted[] = [];
let stand: StandIn;
let project: string;
let space: string;
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  space = stand.addTeam("Birch Studio", [SELF]);
  project = stand.addProject(SELF, { name: "Canvas", fullName: "example/canvas" }, space);
});
afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});
const proposal: NonNullable<HostedDeps["nameThread"]> = async (thread, input) =>
  thread.title === titleFromPrompt(input.prompt ?? "") ? { title: "CSV export with filters", expectedTitle: thread.title } : null;
async function app(device = newDevice(), overrides: Partial<HostedDeps> = {}) {
  const { deps, browser } = hostDeps(stand, device, { nameThread: proposal, ...overrides });
  const hosted = createHosted(deps);
  if (!(hosted.threads instanceof Threads)) throw new Error("Missing thread catalog");
  const threads = hosted.threads;
  const refresh = () => threads.refresh();
  hosts.push(hosted);
  await hosted.start();
  if (!device.stored) await signInAs(hosted, browser, SELF);
  await refresh();
  return { hosted, device, refresh };
}
function thread(age: number, title = "", complete = true) {
  const id = stand.addThread(SELF, { projectId: project, title, createdAt: new Date(Date.now() - age).toISOString(), status: complete ? "idle" : "working" });
  stand.append(id, [{ type: "message.completed", ts: Date.now(), messageId: crypto.randomUUID(), role: "user", text: PROMPT }], { by: `user-${SELF}` });
  if (complete) finish(id);
  return id;
}
function finish(id: string) {
  stand.append(id, [{ type: "message.completed", ts: Date.now(), messageId: crypto.randomUUID(), role: "assistant", text: "Export follows the filters." }]);
  stand.endTurn(id);
}
function examined(device: Device): string[] {
  const records = z.array(z.object({ data: z.object({ names: keptThreadNames }) })).parse(JSON.parse(device.threads ?? "[]"));
  return records.flatMap((record) =>
    Object.entries(record.data.names)
      .filter(([, value]) => value.state === "examined")
      .map(([id]) => id),
  );
}
const detail = (url: URL) => /^\/hosted\/threads\/[^/]+$/.test(url.pathname);
const titleReads = () => stand.requests.filter((request) => request.method === "GET" && /^\/hosted\/threads\/[^/]+(?:\/events)?$/.test(request.path));
const listedTitle = (hosted: Hosted, id: string) => hosted.threads.listed("threads.list", {})?.rows.find((row) => row.id === id)?.title;

it("examines 50 recent threads newest first with only one title request in flight", async () => {
  const ids = Array.from({ length: 50 }, (_, n) => thread((n + 1) * 1000));
  let pending = 0;
  let peak = 0;
  const started: string[] = [];
  const releases: (() => void)[] = [];
  const { device } = await app(newDevice(), {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (!detail(url) && !url.pathname.endsWith("/events")) return fetch(input, init);
      pending++;
      peak = Math.max(peak, pending);
      try {
        if (detail(url) && init?.method === "GET") {
          started.push(url.pathname.split("/").at(-1)!);
          await new Promise<void>((resolve) => releases.push(resolve));
        }
        return await fetch(input, init);
      } finally {
        pending--;
      }
    },
  });
  for (let n = 0; n < 50; n++) {
    await vi.waitFor(() => expect(releases).toHaveLength(n + 1), { interval: 5 });
    expect(started).toEqual(ids.slice(0, n + 1));
    expect(pending).toBe(1);
    releases[n]!();
  }
  await vi.waitFor(() => expect(examined(device)).toHaveLength(50));
  expect(peak).toBe(1);
  expect(titleReads()).toHaveLength(100);
});

it("keeps 50 completed checks across restart, space changes and temporarily absent rows", async () => {
  const ids = Array.from({ length: 50 }, (_, n) => thread(n * 1000, `Export ${n}`));
  const first = await app();
  await vi.waitFor(() => expect(examined(first.device)).toHaveLength(50));
  first.hosted.close();
  stand.requests.length = 0;
  let hide = false;
  const { hosted, refresh } = await app(first.device, {
    fetch: (input, init) => (hide && new URL(String(input)).pathname === "/hosted/threads" ? Promise.resolve(Response.json({ threads: [] })) : fetch(input, init)),
  });
  for (const spaceId of [`space-${SELF}`, space, `space-${SELF}`, space]) {
    hosted.threads.listed("threads.list", { spaceId });
    await refresh();
  }
  hide = true;
  await refresh();
  expect(hosted.threads.listed("threads.list", {})?.rows).toEqual([]);
  hide = false;
  await refresh();
  expect(hosted.threads.listed("threads.list", {})?.rows).toHaveLength(50);
  expect(new Set(examined(first.device))).toEqual(new Set(ids));
  expect(titleReads()).toHaveLength(0);
  await hosted.account.signOut();
  expect(first.device.threads).toBeNull();
});

it("ignores old history but names an old thread when its watched first turn finishes", async () => {
  const old = thread(TITLE_DISCOVERY_MS + 1000);
  const live = thread(TITLE_DISCOVERY_MS + 1000, "", false);
  const { hosted, device } = await app();
  expect(titleReads()).toHaveLength(0);
  await hosted.threads.call("events.page", { runId: `hosted:${live}`, turns: 2 });
  stand.requests.length = 0;
  finish(live);
  await vi.waitFor(() => expect(listedTitle(hosted, live)).toBe("CSV export with filters"));
  expect(listedTitle(hosted, old)).toBe("Add CSV export");
  expect(examined(device)).toEqual([live]);
  expect(stand.requests.some((request) => request.path.endsWith(old))).toBe(false);
});

it("does not rediscover an old first turn when a later watched turn ends", async () => {
  const id = thread(TITLE_DISCOVERY_MS + 1000);
  const { hosted, refresh } = await app();
  await hosted.threads.call("events.page", { runId: `hosted:${id}`, turns: 2 });
  stand.requests.length = 0;
  finish(id);
  await refresh();
  expect(titleReads()).toHaveLength(0);
  expect(listedTitle(hosted, id)).toBe("Add CSV export");
});

it("names a watched first turn that finishes while the opening page is still arriving", async () => {
  const id = thread(TITLE_DISCOVERY_MS + 1000, "", false);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reading = false;
  const { hosted } = await app(newDevice(), {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/events") && url.searchParams.has("lastTurns")) {
        reading = true;
        await gate;
      }
      return fetch(input, init);
    },
  });
  const opening = hosted.threads.call("events.page", { runId: `hosted:${id}`, turns: 2 });
  await vi.waitFor(() => expect(reading).toBe(true));
  finish(id);
  release();
  await opening;
  await vi.waitFor(() => expect(listedTitle(hosted, id)).toBe("CSV export with filters"));
});

it("keeps failed-read pauses across lists and restart, then retries after the pause", async () => {
  const id = thread(1000);
  let now = Date.now();
  let reads = 0;
  const intercept: typeof fetch = (input, init) => {
    if (detail(new URL(String(input))) && init?.method === "GET") {
      reads++;
      if (reads === 1) return Promise.resolve(Response.json({ message: "Try later." }, { status: 503 }));
    }
    return fetch(input, init);
  };
  const first = await app(newDevice(), { fetch: intercept, now: () => now });
  await vi.waitFor(() => expect(first.device.threads).toContain('"retry"'));
  for (let n = 0; n < 5; n++) await first.refresh();
  first.hosted.close();
  const { hosted, refresh } = await app(first.device, { fetch: intercept, now: () => now });
  expect(reads).toBe(1);
  now += TITLE_RETRY_MS - 1;
  await refresh();
  expect(reads).toBe(1);
  now++;
  await refresh();
  await vi.waitFor(() => expect(listedTitle(hosted, id)).toBe("CSV export with filters"));
  expect(reads).toBe(2);
});
