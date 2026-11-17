import { hostedRunId, type RpcReply, type RpcRequest, type ThreadSummary } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createHosted, type Hosted } from "../index.js";
import { Threads } from "../threads.js";
import { hostDeps, newDevice, signInAs } from "../test-fixtures/host.js";
import { standIn, type StandIn } from "../testing/stand-in.js";
import { PlaceRouter } from "./place-router.js";

/*
 * The router as a phone runs it: OpenOrc Cloud's own client answers for what it holds, and `next` is the phone's link to
 * the Mac, which answers for the Mac's threads. One list holds both, and nothing of the cloud's goes down the link.
 */
const SELF = "member@example.com";
const MAC_PROJECT = "mac-canvas";
let stand: StandIn;
let space: string;
let cloudThread: string;
let hosted: Hosted;
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  space = stand.addTeam("Birch Studio", [SELF]);
  const project = stand.addProject(SELF, { name: "Canvas", fullName: "example/canvas" }, space);
  cloudThread = stand.addThread(SELF, { projectId: project, title: "Export in the cloud", status: "idle" });
  // The Mac has the same repository as a project of its own, so the space's project is one, on both.
  const device = { ...newDevice(), projects: [{ id: MAC_PROJECT, remote: "https://github.com/example/canvas" }] };
  const { deps, browser } = hostDeps(stand, device);
  hosted = createHosted(deps);
  await hosted.start();
  await signInAs(hosted, browser, SELF);
  if (!(hosted.threads instanceof Threads)) throw new Error("Missing thread catalog");
  await hosted.threads.refresh();
});
afterEach(async () => {
  hosted.close();
  await stand.close();
});

/** The phone's link to the Mac: what it was asked, and the Mac's answers for its own thread. */
function macLink(macRow: ThreadSummary) {
  const asked: RpcRequest[] = [];
  const next = async (request: RpcRequest): Promise<RpcReply> => {
    asked.push(request);
    const params = request.params as { id?: string; projectIds?: string[] };
    if (request.method === "threads.list") return { type: "rpc.result", id: request.id, result: params.projectIds?.includes(MAC_PROJECT) ? [macRow] : [] };
    if (request.method === "threads.get" && params.id === macRow.id) return { type: "rpc.result", id: request.id, result: macRow };
    return { type: "rpc.error", id: request.id, message: "Not on this Mac." };
  };
  return { asked, next };
}

it("runs over a phone's link to the Mac: the cloud answers its own threads, the link the Mac's, and one list holds both", async () => {
  const cloudRow = hosted.threads.listed("threads.list", {})!.rows.find((row) => row.id === cloudThread)!;
  const macRow: ThreadSummary = { ...cloudRow, id: "mac-thread", title: "Export on the Mac", projectId: MAC_PROJECT, owner: undefined };
  const link = macLink(macRow);
  const router = new PlaceRouter({ place: () => hosted.threads, spaces: () => hosted.spaces, next: link.next });
  const call = async (id: number, method: string, params: unknown) => {
    const reply = await router.handle({ type: "rpc", id, method, params });
    if (reply.type === "rpc.error") throw new Error(reply.message);
    return reply.result;
  };

  const list = (await call(1, "threads.list", { spaceId: space })) as ThreadSummary[];
  expect(list.map((row) => [row.id, row.owner?.brain ?? "mac"])).toEqual(
    expect.arrayContaining([
      [cloudThread, "hosted"],
      ["mac-thread", "mac"],
    ]),
  );
  expect(link.asked.map((request) => [request.method, request.params])).toEqual([["threads.list", expect.objectContaining({ projectIds: [MAC_PROJECT] })]]);

  expect(await call(2, "threads.get", { id: cloudThread })).toMatchObject({ id: cloudThread, owner: { brain: "hosted" } });
  expect(await call(3, "events.page", { runId: hostedRunId(cloudThread), fromTurn: 0 })).toMatchObject({ events: expect.any(Array) });
  expect(await call(4, "threads.get", { id: "mac-thread" })).toEqual(macRow);
  // The link heard the Mac's thread and the Mac's list, and never a cloud id.
  expect(link.asked.map((request) => request.method)).toEqual(["threads.list", "threads.get"]);
  expect(JSON.stringify(link.asked)).not.toContain(cloudThread);
});

it("starts a person's subthread under a cloud thread on OpenOrc Cloud, never down the link", async () => {
  const cloudRow = hosted.threads.listed("threads.list", {})!.rows.find((row) => row.id === cloudThread)!;
  const link = macLink({ ...cloudRow, id: "mac-thread", projectId: MAC_PROJECT, owner: undefined });
  stand.setBilling(SELF, { pro: true, standing: "live", at: new Date(Date.now() + 20 * 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
  stand.setSignIns(SELF, [{ agent: "claude" }]);
  const router = new PlaceRouter({ place: () => hosted.threads, spaces: () => hosted.spaces, next: link.next });
  const reply = await router.handle({
    type: "rpc",
    id: 1,
    method: "threads.start",
    params: {
      spaceId: space,
      projectId: cloudRow.projectId,
      parentThreadId: cloudThread,
      agent: "claude",
      model: "opus",
      mode: "act",
      permissionMode: "trusted",
      prompt: "Draw the hero",
      attachments: [],
    },
  });
  if (reply.type === "rpc.error") throw new Error(reply.message);
  expect((reply.result as { thread: ThreadSummary }).thread).toMatchObject({ parentThreadId: cloudThread, owner: { brain: "hosted" } });
  expect(link.asked.map((request) => request.method)).not.toContain("threads.start");
});
