import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { Threads } from "./threads.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const SELF = "member@example.com";
let stand: StandIn;
let parentId: string;
let hosted: Hosted;
let threads: Threads;
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  const space = stand.addTeam("Birch Studio", [SELF]);
  const project = stand.addProject(SELF, { name: "Canvas", fullName: "example/canvas" }, space);
  parentId = stand.addThread(SELF, { projectId: project, title: "Export in the cloud", branch: "openorc/export-1a2b3c4d" });
  const { deps, browser } = hostDeps(stand, newDevice());
  hosted = createHosted(deps);
  await hosted.start();
  await signInAs(hosted, browser, SELF);
  if (!(hosted.threads instanceof Threads)) throw new Error("Missing thread catalog");
  threads = hosted.threads;
  await threads.refresh();
});
const forksAsked = () => stand.requests.filter((request) => request.method === "POST" && request.path.endsWith("/fork")).length;
afterEach(async () => {
  hosted.close();
  await stand.close();
});

it("forks a cloud thread on the server into a thread of the asker's own, listed at once, the same fork however often its key is asked", async () => {
  const requestKey = randomUUID();
  const fork = await threads.call("threads.fork", { id: parentId, requestKey });
  expect(fork).toMatchObject({ id: requestKey, title: "Export in the cloud (fork)", owner: { brain: "hosted" } });
  expect(threads.listed("threads.list", {})!.rows.map((row) => row.id)).toContain(requestKey);
  expect(await threads.call("threads.fork", { id: parentId, requestKey })).toMatchObject({ id: requestKey });
  expect(threads.listed("threads.list", {})!.rows.filter((row) => row.id === requestKey)).toHaveLength(1);
  expect(forksAsked()).toBe(2);
});

it("refuses to fork a thread it doesn't hold, and asks the server nothing", async () => {
  await expect(threads.call("threads.fork", { id: "mac-thread", requestKey: randomUUID() })).rejects.toThrow("That conversation isn't available on OpenOrc Cloud.");
  expect(forksAsked()).toBe(0);
});
