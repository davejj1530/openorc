import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { titleFromPrompt } from "@openorc/protocol";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, signInAs, storedToken } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const SELF = "alex@example.com";
const TEAMMATE = "mira@example.com";
const PROMPT = "Add CSV export\nwith filters";
const hosts: Hosted[] = [];
let stand: StandIn;
let space: string;
let project: string;
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  space = stand.addTeam("Birch Studio", [SELF, TEAMMATE]);
  project = stand.addProject(SELF, { name: "Canvas", fullName: "example/canvas" }, space);
  stand.setBilling(SELF, { pro: true, standing: "live", at: new Date(Date.now() + 86400000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
  stand.setSignIns(SELF, [{ agent: "codex" }]);
});
afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});
async function app(email = SELF, overrides: Partial<HostedDeps> = {}) {
  const device = newDevice();
  const { deps, browser, seen } = hostDeps(stand, device, overrides);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, email);
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  return { hosted, seen, device, token: () => storedToken(device) };
}
function pause() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const title = (hosted: Hosted, id: string) => hosted.threads.listed("threads.list", {})?.rows.find((row) => row.id === id)?.title;
function exchange(id: string, prompt = PROMPT, by = SELF) {
  stand.append(id, [{ type: "message.completed", ts: Date.now(), messageId: crypto.randomUUID(), role: "user", text: prompt }], { by: `user-${by}` });
  stand.append(id, [{ type: "message.completed", ts: Date.now(), messageId: crypto.randomUUID(), role: "assistant", text: "Export now follows the filters." }]);
  stand.endTurn(id);
}
const proposal: NonNullable<HostedDeps["nameThread"]> = async (thread, input) =>
  thread.title === titleFromPrompt(input.prompt ?? "") ? { title: "CSV export with filters", expectedTitle: thread.title } : null;

it("shows first-line names at creation and never gives a blank row or detail", async () => {
  const { hosted } = await app();
  const made = await hosted.threads.call("threads.start", {
    projectId: `openorc-cloud:${project}`,
    spaceId: space,
    prompt: PROMPT,
    agent: "codex",
    mode: "act",
    permissionMode: "trusted",
  });
  expect(made.thread.title).toBe("Add CSV export");
  const empty = stand.addThread(SELF, { projectId: project, title: "  " });
  await vi.waitFor(() => expect(title(hosted, empty)).toBe("New thread"));
  expect(await hosted.threads.call("threads.get", { id: empty })).toMatchObject({ title: "New thread" });
  await hosted.threads.call("runs.start", { threadId: empty, prompt: "A later first message", agent: "codex", mode: "act", permissionMode: "trusted" });
  await vi.waitFor(() => expect(title(hosted, empty)).toBe("A later first message"));
});

it("names only the sender's first completed exchange and shares the result live", async () => {
  const id = stand.addThread(SELF, { projectId: project, title: "", status: "working", agent: "codex" });
  const naming = vi.fn(proposal);
  const strangerNaming = vi.fn(proposal);
  const { hosted } = await app(SELF, { nameThread: naming });
  const { hosted: teammate } = await app(TEAMMATE, { nameThread: strangerNaming });
  exchange(id);
  await vi.waitFor(() => expect(title(hosted, id)).toBe("CSV export with filters"));
  await vi.waitFor(() => expect(title(teammate, id)).toBe("CSV export with filters"));
  expect(naming).toHaveBeenCalledOnce();
  expect(naming).toHaveBeenCalledWith({ id, title: "Add CSV export", agent: "codex" }, { prompt: PROMPT, reply: "Export now follows the filters." });
  expect(strangerNaming).not.toHaveBeenCalled();
  exchange(id, "Now add tests");
  hosted.awoke();
  await vi.waitFor(async () => expect((await hosted.threads.call("events.page", { runId: `hosted:${id}`, turns: 2 })).events).toHaveLength(6));
  expect(naming).toHaveBeenCalledOnce();
});

it("keeps an old blank cached row readable while the server is unavailable", async () => {
  const id = stand.addThread(SELF, { projectId: project, title: "Kept" });
  const { hosted, device } = await app();
  await vi.waitFor(() => expect(title(hosted, id)).toBe("Kept"));
  hosted.close();
  device.threads = device.threads!.replace('"title":"Kept"', '"title":"  "');
  await stand.down();
  const { deps } = hostDeps(stand, device);
  const restarted = createHosted(deps);
  hosts.push(restarted);
  await restarted.start();
  expect(title(restarted, id)).toBe("New thread");
  expect(await restarted.threads.call("threads.get", { id })).toMatchObject({ title: "New thread" });
});

it("reads an already completed first exchange across page boundaries after reconnecting", async () => {
  const id = stand.addThread(SELF, { projectId: project, title: "", agent: "codex" });
  stand.append(id, [{ type: "message.completed", ts: 1, messageId: "first", role: "user", text: PROMPT }], { by: `user-${SELF}` });
  stand.append(
    id,
    Array.from({ length: 2001 }, (_, n) => ({ type: "message.delta", ts: n + 2, messageId: "reply", role: "assistant", text: "." })),
  );
  stand.append(id, [{ type: "message.completed", ts: 3000, messageId: "reply", role: "assistant", text: "First result" }]);
  stand.endTurn(id);
  exchange(id, "A second request");
  const naming = vi.fn(proposal);
  const { hosted } = await app(SELF, { nameThread: naming });
  await vi.waitFor(() => expect(title(hosted, id)).toBe("CSV export with filters"));
  expect(naming).toHaveBeenCalledWith(expect.anything(), { prompt: PROMPT, reply: "First result" });
});

it("keeps a manual rename made while the small model is answering", async () => {
  const id = stand.addThread(SELF, { projectId: project, title: "", agent: "codex" });
  exchange(id);
  const ready = pause();
  const naming = vi.fn(async (...args: Parameters<NonNullable<HostedDeps["nameThread"]>>) => {
    await ready.promise;
    return proposal(...args);
  });
  const { hosted } = await app(SELF, { nameThread: naming });
  await vi.waitFor(() => expect(naming).toHaveBeenCalledOnce());
  await hosted.threads.call("threads.update", { id, patch: { title: "Quarterly export" } });
  ready.resolve();
  await vi.waitFor(() => expect(stand.requests.filter((r) => r.method === "PATCH" && r.path.endsWith(id))).toHaveLength(2));
  expect(title(hosted, id)).toBe("Quarterly export");
});

it("lets only the first device's generated title win", async () => {
  const id = stand.addThread(SELF, { projectId: project, title: "", agent: "codex" });
  exchange(id);
  const first = pause();
  const second = pause();
  const naming = (gate: Promise<void>, text: string) =>
    vi.fn(async (thread: Parameters<NonNullable<HostedDeps["nameThread"]>>[0]) => {
      await gate;
      return { title: text, expectedTitle: thread.title };
    });
  const nameOne = naming(first.promise, "First result");
  const nameTwo = naming(second.promise, "Second result");
  const { hosted: one } = await app(SELF, { nameThread: nameOne });
  const { hosted: two } = await app(SELF, { nameThread: nameTwo });
  await vi.waitFor(() => expect(nameTwo).toHaveBeenCalledOnce());
  first.resolve();
  await vi.waitFor(() => expect(title(one, id)).toBe("First result"));
  second.resolve();
  await vi.waitFor(() => expect(stand.requests.filter((r) => r.method === "PATCH" && r.path.endsWith(id))).toHaveLength(2));
  await vi.waitFor(() => expect(title(two, id)).toBe("First result"));
});

it("drops a delayed title after sign-out and leaves a missing model's first-line name", async () => {
  const id = stand.addThread(SELF, { projectId: project, title: "", agent: "codex" });
  exchange(id);
  const ready = pause();
  const named = vi.fn(async (...args: Parameters<NonNullable<HostedDeps["nameThread"]>>) => {
    await ready.promise;
    return proposal(...args);
  });
  const { hosted } = await app(SELF, { nameThread: named });
  await vi.waitFor(() => expect(named).toHaveBeenCalledOnce());
  await hosted.account.signOut();
  ready.resolve();
  const unavailable = vi.fn(async () => null);
  const { hosted: next } = await app(SELF, { nameThread: unavailable });
  await vi.waitFor(() => expect(unavailable).toHaveBeenCalledOnce());
  expect(title(next, id)).toBe("Add CSV export");
  expect(stand.requests.filter((r) => r.method === "PATCH" && r.path.endsWith(id))).toEqual([]);
});

it("answers a conditional mismatch with the unchanged whole row, including settings", async () => {
  const id = stand.addThread(SELF, { projectId: project, title: "Renamed", agent: "codex" });
  const { token } = await app();
  const result = await fetch(`${stand.url}/hosted/threads/${id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token()}`, "x-openorc-space": space, "content-type": "application/json" },
    body: JSON.stringify({ title: "Generated", expectedTitle: "Original", settings: { model: "other" } }),
  });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ title: "Renamed", settings: { model: null } });
});
