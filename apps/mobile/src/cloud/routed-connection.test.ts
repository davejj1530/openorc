import type { ClientPush } from "@openorc/client";
import type { Hosted } from "@openorc/hosted";
import { standIn, type StandIn } from "@openorc/hosted/testing";
import { hostedRunId, type RpcMethod, type ThreadSummary } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keptAnswers, type KeptAnswers } from "../lists-cache";
import { RoutedConnection, type MacLine } from "./routed-connection";
import { accountOn } from "./test-fixtures/stand-in-account";

/*
 * One list, two answerers: with a session of its own, the phone's cloud answers for the threads it holds and adds its
 * rows to a space's list, and the Mac, over the link, answers for its own. A project both have is one project; nothing
 * of the cloud's goes down the link; with the Mac asleep the cloud's threads still list, open and page.
 */

const RILEY = "riley@example.com";
const MAC_PROJECT = "mac-canvas";
let stand: StandIn;
let birch: string;
let cloudThread: string;
let hosted: Hosted;
let pushes: ClientPush[];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  birch = stand.addTeam("Birch Studio", [RILEY]);
  const project = stand.addProject(RILEY, { name: "canvas", fullName: "example/canvas" }, birch);
  cloudThread = stand.addThread(RILEY, { projectId: project, title: "Export in the cloud" });
  // The phone's own cloud, matching the cloud's projects to the folders the Mac listed.
  hosted = await accountOn(stand, RILEY, { projects: () => [{ id: MAC_PROJECT, name: "canvas", remote: "https://github.com/example/canvas.git" }] });
  pushes = [];
});
afterEach(async () => {
  hosted.close();
  await stand.close();
});

/** The phone's link to the Mac: what it was asked, its answers for its own thread, and whether it is out of reach. */
function macLink(macRow: ThreadSummary) {
  const at = { down: false, asked: [] as { method: string; params: unknown }[], interest: [] as string[] };
  const listeners = new Set<(push: ClientPush) => void>();
  const line: MacLine = {
    call: (async (method: RpcMethod, params: Record<string, unknown>) => {
      at.asked.push({ method, params });
      if (at.down) throw new Error("The phone is not connected to its Mac.");
      if (method === "threads.list") return (params["projectIds"] as string[] | undefined)?.includes(MAC_PROJECT) ? [macRow] : [];
      if (method === "threads.resolvedCount") return 0;
      if (method === "threads.get") return params["id"] === macRow.id ? macRow : null;
      if (method === "spaces.status") return { state: "signed-out" };
      throw new Error("Not on this Mac.");
    }) as MacLine["call"],
    onPush: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setFrameInterest: (runIds) => void (at.interest = [...runIds]),
  };
  return { at, line, push: (push: ClientPush) => listeners.forEach((listener) => listener(push)) };
}

async function routed(own: Hosted | null = hosted, kept?: KeptAnswers) {
  const cloudRow = await vi.waitFor(() => {
    const row = (hosted.threads.listed("threads.list", {})?.rows ?? []).find((each) => each.id === cloudThread);
    if (!row) throw new Error("The cloud has not listed its thread yet.");
    return row;
  });
  const macRow: ThreadSummary = { ...cloudRow, id: "mac-thread", title: "Export on the Mac", projectId: MAC_PROJECT, owner: undefined };
  const mac = macLink(macRow);
  const connection = new RoutedConnection(mac.line, { hosted: own }, kept);
  connection.onPush((push) => void pushes.push(push));
  return { connection, mac, macRow };
}

it("lists a space's cloud threads and the Mac's in one list, its project both have as one, and sends no cloud id down the link", async () => {
  const { connection, mac } = await routed();
  const [project] = await connection.call("spaces.projects", { spaceId: birch });
  expect(project).toMatchObject({ name: "canvas", localProjectId: MAC_PROJECT, hostedProjectId: expect.any(String) });
  const list = await connection.call("threads.list", { spaceId: birch });
  expect(list.map((row) => [row.id, row.owner?.brain ?? "mac"]).sort()).toEqual([
    [cloudThread, "hosted"],
    ["mac-thread", "mac"],
  ]);
  expect(await connection.call("threads.get", { id: cloudThread })).toMatchObject({ id: cloudThread, owner: { brain: "hosted" } });
  expect(await connection.call("events.page", { runId: hostedRunId(cloudThread), fromTurn: 0 })).toMatchObject({ events: expect.any(Array) });
  expect(await connection.call("threads.get", { id: "mac-thread" })).toMatchObject({ id: "mac-thread" });
  expect(mac.at.asked.map((call) => call.method)).toEqual(["threads.list", "threads.get"]);
  expect(JSON.stringify(mac.at.asked)).not.toContain(cloudThread);
});

it("reads a space's repositories and adds one as a project through the phone's own session, with the Mac asleep", async () => {
  const { connection, mac } = await routed();
  mac.at.down = true;
  expect(await connection.call("organization.repositories", { spaceId: birch })).toMatchObject({ installations: [], repositories: [] });
  expect(await connection.call("organization.projects.add", { spaceId: birch, repositories: [{ installationId: "one", repoId: 1 }] })).toMatchObject([{ state: "refused" }]);
  expect(mac.at.asked).toEqual([]);
});

it("keeps listing, opening and paging the cloud's threads with the Mac asleep, the Mac's last rows beside them", async () => {
  const { connection, mac } = await routed();
  await connection.call("threads.list", { spaceId: birch });
  mac.at.down = true;
  const list = await connection.call("threads.list", { spaceId: birch });
  expect(list.map((row) => row.id).sort()).toEqual([cloudThread, "mac-thread"].sort());
  expect(await connection.call("threads.resolvedCount", { spaceId: birch, projectIds: [MAC_PROJECT], quietBefore: 0 })).toBeGreaterThanOrEqual(0);
  expect(await connection.call("threads.get", { id: cloudThread })).toMatchObject({ id: cloudThread });
  expect(await connection.call("events.page", { runId: hostedRunId(cloudThread), fromTurn: 0 })).toMatchObject({ events: expect.any(Array) });
  stand.threadFiles.capabilities = { toolOutput: { available: true } };
  stand.append(cloudThread, [{ type: "tool.completed", ts: Date.now(), toolCallId: "tool-whole", output: "line of output\n".repeat(2_000) }]);
  expect(await connection.call("events.toolOutput", { runId: hostedRunId(cloudThread), toolCallId: "tool-whole" })).toEqual({ output: "line of output\n".repeat(2_000) });
  // The Mac's own thread waits for the Mac.
  await expect(connection.call("threads.get", { id: "mac-thread" })).rejects.toThrow("not connected");
});

it("lists the Mac's last rows after a relaunch with the Mac asleep, from the answers kept for it", async () => {
  const saved = new Map<string, string>();
  const storage = { getString: (key: string) => saved.get(key), set: (key: string, value: string) => void saved.set(key, value), remove: (key: string) => void saved.delete(key) };
  const before = await routed(
    hosted,
    keptAnswers(storage, () => "studio"),
  );
  await before.connection.call("threads.list", { spaceId: birch });
  // A new launch: a new router, the Mac asleep from the start.
  const after = await routed(
    hosted,
    keptAnswers(storage, () => "studio"),
  );
  after.mac.at.down = true;
  const list = await after.connection.call("threads.list", { spaceId: birch });
  expect(list.map((row) => row.id).sort()).toEqual([cloudThread, "mac-thread"].sort());
});

it("answers the spaces, the person and their cloud accounts from its own session, as the Mac shaped them for a phone", async () => {
  const { connection, mac } = await routed();
  await vi.waitFor(async () => expect(await connection.call("spaces.status", {})).toMatchObject({ state: "ready" }));
  const status = await connection.call("spaces.status", {});
  expect(status).toMatchObject({ apiOrigin: "", invitations: [], create: { allowed: false } });
  expect(await connection.call("account.person" as RpcMethod, {} as never)).toMatchObject({ name: expect.any(String) });
  expect(await connection.call("account.status", {})).toMatchObject({ state: "signed-in" });
  expect(mac.at.asked).toEqual([]);
});

it("sends every call to the Mac while the phone holds no session of its own, and hands the client both sides' pushes", async () => {
  const { connection, mac } = await routed(null);
  await connection.call("spaces.status", {});
  await connection.call("threads.list", { spaceId: birch });
  expect(mac.at.asked.map((call) => call.method)).toEqual(["spaces.status", "threads.list"]);
  expect(mac.at.asked[1]!.params).toEqual({ spaceId: birch });
  connection.setFrameInterest(new Set(["run-1"]));
  expect(mac.at.interest).toEqual(["run-1"]);
  mac.push({ type: "invalidate", keys: ["threads"] });
  connection.cloudPush({ type: "invalidate", keys: ["spaces"] });
  connection.cloudPush({ type: "gap", runIds: ["r"] });
  expect(pushes).toEqual([
    { type: "invalidate", keys: ["threads"] },
    { type: "invalidate", keys: ["spaces"] },
    { type: "gap", runIds: ["r"] },
  ]);
});

it("answers team chat from its own session with the Mac asleep, and asks the Mac nothing of it", async () => {
  Object.assign(stand.chat, { enabled: true, channelsEnabled: true });
  const { connection, mac } = await routed();
  mac.at.down = true;
  await vi.waitFor(() => expect(hosted.spaces.status().state).toBe("ready"));
  expect(await connection.call("teamChat.state", { spaceId: birch })).toMatchObject({ state: "ready", spaceId: birch });
  const channel = await connection.call("teamChat.createChannel", { spaceId: birch, name: "launch" });
  await connection.call("teamChat.send", { spaceId: birch, conversationId: channel.id, id: crypto.randomUUID(), body: "Checklist is done" });
  expect((await connection.call("teamChat.timeline", { spaceId: birch, conversationId: channel.id })).messages.map((message) => message.body)).toEqual(["Checklist is done"]);
  expect(mac.at.asked.filter((each) => each.method.startsWith("teamChat."))).toEqual([]);
});
