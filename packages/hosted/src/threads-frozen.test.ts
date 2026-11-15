import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted, type HostedDeps } from "./index.js";
import { hostDeps, newDevice, signInAs, testBrowser } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const ADMIN = "alex@example.com",
  MEMBER = "mira@example.com";
const active = { state: "active", reason: null, until: null, message: null } as const;
const frozen = { state: "frozen", reason: "seat_removed", until: null, message: "Your seat was taken back, and your day of grace has ended." } as const;
const grace = (until: number) =>
  ({ state: "grace", reason: "seat_removed", until: new Date(until).toISOString(), message: "Your seat was taken back; you have one day to get Pro to keep using organizations." }) as const;
const paid = (until = Date.now() + 86_400_000) => ({ pro: true, standing: "live" as const, at: new Date(until).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
let stand: StandIn;
let thread: string;
const hosts: Hosted[] = [];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  const team = stand.addTeam("Birch Studio", [ADMIN, MEMBER]);
  const projectId = stand.addProject(ADMIN, { name: "Canvas", fullName: "example/canvas" }, team);
  thread = stand.addThread(ADMIN, { projectId, title: "Shared export" });
});
afterEach(async () => {
  hosts.splice(0).forEach((host) => host.close());
  await stand.close();
});
async function member(overrides: Partial<HostedDeps> = {}) {
  const browser = testBrowser(stand);
  const { deps } = hostDeps(stand, newDevice(), { browser, ...overrides });
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, MEMBER);
  await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true));
  await hosted.threads.call("threads.update", { id: thread, patch: { draft: "Keep the filters as they are." } });
  return hosted;
}

it("keeps a frozen person's unsent words in an organization's thread for when access returns", { timeout: 20_000 }, async () => {
  stand.setBilling(MEMBER, { ...paid(), organizationAccess: active });
  const hosted = await member();
  // The server's notice of the change, as the stand-in sends none for billing it is told.
  stand.setBilling(MEMBER, { pro: false, organizationAccess: frozen });
  await hosted.spaces.refresh();
  expect(hosted.spaces.status()).toMatchObject({ organizationAccess: { state: "frozen" } });
  await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(false), { timeout: 5000 });
  stand.setBilling(MEMBER, { ...paid(), organizationAccess: active });
  await hosted.spaces.refresh();
  await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true), { timeout: 5000 });
  expect(await hosted.threads.call("threads.get", { id: thread })).toMatchObject({ draft: "Keep the filters as they are." });
});

it("closes an organization's threads at the grace deadline with nothing heard from the server, keeping their drafts", { timeout: 30_000 }, async () => {
  const until = Date.now() + 2_500;
  stand.setBilling(MEMBER, { ...paid(until), standing: "grace", organizationAccess: grace(until) });
  const hosted = await member();
  await stand.down();
  await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(false), { timeout: 8000 });
  stand.setBilling(MEMBER, { ...paid(), organizationAccess: active });
  await stand.up();
  await hosted.spaces.refresh();
  await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true), { timeout: 10000 });
  expect(await hosted.threads.call("threads.get", { id: thread })).toMatchObject({ draft: "Keep the filters as they are." });
});
