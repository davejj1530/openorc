import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { CLOUD_PROJECT } from "./translate.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";
import { SUBTHREADS, SUBTHREADS_FULL } from "./testing/stand-in-thread-placement.js";

/*
 * A person starts a thread of their own under a cloud thread, as under a thread on this Mac: it starts on OpenOrc Cloud
 * in the parent's project, its server told the parent, and it reads as the parent's child.
 */
const ADA = "ada@example.com";
const SETTINGS = { agent: "claude", model: "opus", mode: "act", permissionMode: "trusted" } as const;
let stand: StandIn;
let hosted: Hosted;
let project: string;
let parent: string;

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  stand.setBilling(ADA, { pro: true, standing: "live", at: new Date(Date.now() + 20 * 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
  stand.setSignIns(ADA, [{ agent: "claude" }]);
  project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
  parent = stand.addThread(ADA, { projectId: project, title: "Ship the launch page" });
  const { deps, browser } = hostDeps(stand, newDevice());
  hosted = createHosted(deps);
  await hosted.start();
  await signInAs(hosted, browser, ADA);
  await vi.waitFor(() => expect(hosted.threads.holds({ thread: parent })).toBe(true));
});
afterEach(async () => {
  hosted.close();
  await stand.close();
});

const under = (parentThreadId: string, projectId = project) => ({ projectId: `${CLOUD_PROJECT}${projectId}`, parentThreadId, ...SETTINGS, prompt: "Draw the hero", attachments: [] });

it("starts a subthread on OpenOrc Cloud under its cloud parent, which it then reads as its child", async () => {
  const started = await hosted.threads.call("threads.start", under(parent));
  expect(stand.started.at(-1)?.body).toMatchObject({ projectId: project, parentThreadId: parent });
  expect(started.thread.parentThreadId).toBe(parent);
  const listed = await hosted.threads.call("threads.get", { id: started.thread.id });
  expect(listed?.parentThreadId).toBe(parent);
});

it("reads a person's subthread as a thread of its own: started under its parent, its history its own, no helper list asked", async () => {
  const started = await hosted.threads.call("threads.start", under(parent));
  const id = started.thread.id;
  await vi.waitFor(async () => expect(await hosted.threads.call("threads.get", { id })).toMatchObject({ parentThreadId: parent, parentRelation: "started" }));
  const asked = stand.requests.length;
  const runs = await hosted.threads.call("runs.listForThread", { threadId: id });
  expect(runs.map((run) => run.threadId)).toEqual([id]);
  expect(stand.requests.slice(asked).some((request) => request.path.endsWith("/subthreads"))).toBe(false);
});

it("starts none under a thread of another project, and says the server's words under a subthread", async () => {
  const other = stand.addProject(ADA, { name: "site", fullName: "altalogy/site" });
  const elsewhere = stand.addThread(ADA, { projectId: other, title: "Another project's thread" });
  await vi.waitFor(() => expect(hosted.threads.holds({ thread: elsewhere })).toBe(true));
  await expect(hosted.threads.call("threads.start", under(elsewhere))).rejects.toThrow("The parent conversation isn't in this space.");
  const child = await hosted.threads.call("threads.start", under(parent));
  await vi.waitFor(() => expect(hosted.threads.holds({ thread: child.thread.id })).toBe(true));
  await expect(hosted.threads.call("threads.start", under(child.thread.id))).rejects.toThrow("A subthread can't have subthreads of its own.");
});

it("holds New subthread in the server's words once a family is full, until one of its subthreads goes", async () => {
  stand.threadFiles.capabilities = { personSubthreads: { available: true } };
  const family: string[] = [];
  for (let n = 0; n < SUBTHREADS; n++) family.push((await hosted.threads.call("threads.start", under(parent))).thread.id);
  const subthreads = async (threadId: string) => (await hosted.threads.call("hosted.capabilities", { threadId })).features.personSubthreads;
  expect(await subthreads(parent)).toEqual({ available: true });
  await expect(hosted.threads.call("threads.start", under(parent))).rejects.toThrow(SUBTHREADS_FULL);
  expect(await subthreads(parent)).toEqual({ available: false, reason: SUBTHREADS_FULL });
  expect(await subthreads(family[0]!)).toEqual({ available: false, reason: SUBTHREADS_FULL });
  await hosted.threads.call("threads.delete", { id: family[0]! });
  await vi.waitFor(async () => expect(await subthreads(parent)).toEqual({ available: true }));
});
