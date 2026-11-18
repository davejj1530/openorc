import type { ThreadMoving } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADA = "ada@example.com";
let stand: StandIn;
const hosts: Hosted[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

it("says in a cloud thread's summary where it is moving, and why its last move stopped, as this Mac's journal has it", async () => {
  const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
  const thread = stand.addThread(ADA, { projectId: project, title: "Bring the launch page here" });
  const journal = new Map<string, ThreadMoving>();
  const { deps, browser } = hostDeps(stand, newDevice());
  const hosted = createHosted({ ...deps, moving: (id) => journal.get(id) ?? null });
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, ADA);
  await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true));
  const moving = async () => (await hosted.threads.call("threads.get", { id: thread }))?.moving ?? null;
  expect(await moving()).toBeNull();
  journal.set(thread, { to: "mac", failed: null });
  expect(await moving()).toEqual({ to: "mac", failed: null });
  journal.set(thread, { to: "mac", failed: "A folder for this thread is already here with other work in it." });
  expect(await moving()).toEqual({ to: "mac", failed: "A folder for this thread is already here with other work in it." });
});

it("lets a thread the server let go of leave the list at once, before its word of it comes", async () => {
  const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
  const thread = stand.addThread(ADA, { projectId: project, title: "Moved to this Mac" });
  const { deps, browser } = hostDeps(stand, newDevice());
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, ADA);
  await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true));
  hosted.threads.letGo!(thread);
  expect(hosted.threads.holds({ thread })).toBe(false);
  expect(hosted.threads.holds({ run: `hosted:${thread}` })).toBe(false);
});

it("reads no conversation for a thread that never saved one, rather than failing the move that asks", async () => {
  const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
  const thread = stand.addThread(ADA, { projectId: project, title: "Never ran" });
  const { deps, browser } = hostDeps(stand, newDevice());
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, ADA);
  await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true));
  const space = hosted.threads.row!(thread).space;
  expect(await hosted.moves.savedSession(space, thread, "claude", AbortSignal.timeout(10_000))).toBeNull();
});
