import type { RpcParams } from "@openorc/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, type Device } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADA = "ada@example.com";
const LIST: RpcParams<"threads.list"> = { projectIds: ["mac-openorc", "openorc-workspace"], filter: "active", includeChildren: true };

let stand: StandIn;
let device: Device;
const hosts: Hosted[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  device = newDevice();
  device.projects = [{ id: "mac-openorc", remote: "git@github.com:Altalogy/openorc.git" }];
});

afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

async function host() {
  const { deps, seen } = hostDeps(stand, device);
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  return { hosted, seen };
}

async function signIn(hosted: Hosted) {
  await hosted.account.sendCode(ADA);
  await hosted.account.signIn(ADA, stand.codeFor(ADA)!);
}

const listed = (hosted: Hosted) => hosted.threads.listed("threads.list", LIST)?.rows ?? [];

describe("hosted threads", () => {
  it("lists nothing and holds nothing while nobody is signed in", async () => {
    const { hosted } = await host();
    expect(hosted.threads.active).toBe(false);
    expect(hosted.threads.listed("threads.list", LIST)).toBeNull();
    expect(hosted.threads.holds({ thread: "anything" })).toBe(false);
    expect(stand.requests).toEqual([]);
  });

  it("puts each thread under the Mac project with its repository, or under its own when this Mac has none", async () => {
    const openorc = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
    const website = stand.addProject(ADA, { name: "website", fullName: "altalogy/website" });
    const retry = stand.addThread(ADA, { projectId: openorc, title: "Retry the cloud start", status: "working" });
    const hero = stand.addThread(ADA, { projectId: website, title: "Redraw the hero" });
    const { hosted } = await host();
    await signIn(hosted);
    await vi.waitFor(() => expect(listed(hosted)).toHaveLength(2));
    const rows = new Map(listed(hosted).map((row) => [row.id, row]));
    expect(rows.get(retry)).toMatchObject({ projectId: "mac-openorc", title: "Retry the cloud start", activity: "running", liveRunId: `hosted:${retry}`, owner: { brain: "hosted", reach: "live" } });
    expect(rows.get(retry)?.owner?.project).toBeUndefined();
    expect(rows.get(hero)).toMatchObject({ projectId: `openorc-cloud:${website}`, activity: "idle", owner: { brain: "hosted", project: { name: "website" } } });
    expect(hosted.threads.holds({ thread: retry })).toBe(true);
    expect(hosted.threads.holds({ run: `hosted:${hero}` })).toBe(true);
    expect(hosted.threads.holds({ thread: "a-mac-thread" })).toBe(false);
    expect(hosted.threads.project(`openorc-cloud:${website}`)).toMatchObject({ name: "website", gitRemote: "https://github.com/altalogy/website" });
    expect(hosted.threads.listed("threads.list", { projectId: "mac-openorc" })?.rows.map((row) => row.id)).toEqual([retry]);
  });

  it("is unread once the agent writes past what the person has seen, and not for their own message", async () => {
    const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
    const thread = stand.addThread(ADA, { projectId: project, title: "Ask" });
    stand.append(thread, [{ type: "message.completed", messageId: "m1", role: "user", text: "Hello" }], { by: "user-ada" });
    const { hosted } = await host();
    await signIn(hosted);
    await vi.waitFor(() => expect(listed(hosted)).toHaveLength(1));
    expect(listed(hosted)[0]).toMatchObject({ unread: false });
    stand.append(thread, [{ type: "message.completed", messageId: "m2", role: "assistant", text: "Hi" }]);
    await vi.waitFor(() => expect(listed(hosted)[0]).toMatchObject({ unread: true }));
  });

  it("reads the list again when the server says threads changed", async () => {
    const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
    const { hosted, seen } = await host();
    await signIn(hosted);
    await vi.waitFor(() => expect(hosted.threads.active).toBe(true));
    const thread = stand.addThread(ADA, { projectId: project, title: "New on the phone" });
    await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true));
    expect(seen.pushes).toContainEqual({ type: "invalidate", keys: ["threads", "runs"] });
  });

  it("keeps its rows through a restart with the server down, offline, and lets them go on sign-out", async () => {
    const project = stand.addProject(ADA, { name: "openorc", fullName: "altalogy/openorc" });
    const thread = stand.addThread(ADA, { projectId: project, title: "Kept" });
    const first = await host();
    await signIn(first.hosted);
    await vi.waitFor(() => expect(listed(first.hosted)).toHaveLength(1));
    first.hosted.close();
    await stand.down();
    const { hosted, seen } = await host();
    expect(listed(hosted)).toMatchObject([{ id: thread, owner: { brain: "hosted", reach: "offline" } }]);
    await hosted.account.signOut();
    expect(hosted.threads.active).toBe(false);
    expect(hosted.threads.holds({ thread })).toBe(false);
    expect(device.threads).toBeNull();
    expect(seen.pushes).toContainEqual({ type: "invalidate", keys: ["threads", "runs"] });
  });
});
