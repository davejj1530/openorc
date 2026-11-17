import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projects, runs, threads } from "@openorc/db";
import { standIn, type StandIn } from "@openorc/hosted/testing";
import { expect, vi } from "vitest";
import { OpenOrc } from "../../openorc.js";
import { rpcClient } from "../../rpc-test-client.js";
import type { Broadcast } from "../../transport.js";
import { RemoteTestClient } from "../test-client.js";

export const ME = "reader@example.com";
export const MARA = "mara@example.com";
const REPOSITORY = "example/canvas";
/** What a phone of today asks for, and what one that shows OpenOrc Cloud threads adds. */
export const TODAY = ["subagent-threads", "reply-images", "skill-lists", "orclings", "task-details", "subthread-starts", "orcling-edits"];
export const CLOUD = [...TODAY, "cloud-threads"];
export const paid = () => ({
  pro: true,
  standing: "live" as const,
  at: new Date(Date.now() + 86_400_000).toISOString(),
  monthlyLeftSeconds: 3600,
  packsLeftSeconds: 0,
  organizationAccess: { state: "active", reason: null, until: null, message: null } as const,
});

/**
 * A Mac signed in as a member of Birch Studio (Mara its admin) and the admin of Alder Works, with a cloud thread in
 * each and in Personal, and a Mac project of the same repository. Cedar Lab is Mara's alone. Phones attach as the app
 * attaches them, their origin with every request.
 */
export async function cloudMac() {
  const stand: StandIn = await standIn({ signup: "open" });
  stand.setBilling(ME, paid());
  stand.setBilling(MARA, paid());
  stand.setSignIns(ME, [{ agent: "claude" }]);
  stand.setPerson(MARA, { name: "Mara Okafor", image: null });
  const birch = stand.addTeam("Birch Studio", [MARA, ME]);
  const alder = stand.addTeam("Alder Works", [ME]);
  const cedar = stand.addTeam("Cedar Lab", [MARA]);
  const project = { name: "Canvas", fullName: REPOSITORY };
  const projectIds = {
    personal: stand.addProject(ME, project),
    birch: stand.addProject(MARA, project, birch),
    alder: stand.addProject(ME, project, alder),
    cedar: stand.addProject(MARA, project, cedar),
  };
  const cloud = {
    birch,
    alder,
    cedar,
    projects: projectIds,
    threads: {
      personal: stand.addThread(ME, { projectId: projectIds.personal, title: "Personal cloud draft" }),
      teammate: stand.addThread(MARA, { projectId: projectIds.birch, title: "Birch pricing page", status: "working" }),
      mine: stand.addThread(ME, { projectId: projectIds.alder, title: "Alder checkout" }),
      cedar: stand.addThread(MARA, { projectId: projectIds.cedar, title: "Cedar roadmap" }),
    },
  };

  const folder = await mkdtemp(path.join(os.tmpdir(), "openorc-cloud-phone-"));
  const windowPushes: Broadcast[] = [];
  let token: string | null = null;
  let secret: string | null = null;
  const core = await OpenOrc.create({
    dataDir: path.join(folder, "data"),
    ephemeral: true,
    transport: { push: (push) => void windowPushes.push(push) },
    accountServer: stand.url,
    accountSecrets: { load: async () => token, save: async (value) => void (token = value) },
    openBrowser: (url) => {
      if (new URL(url).pathname === "/sign-in") void fetch(stand.signInPage(url, ME));
    },
    remoteSecrets: { load: async () => secret, save: async (value) => void (secret = value) },
    remoteNetwork: { port: 0, machine: { name: () => "QA", lanHosts: () => ["127.0.0.1"], tailnetHosts: async () => [] } },
  });
  const macProject = projects.insert(core.db, { name: "Canvas", rootPath: path.join(folder, "canvas"), gitRemote: `https://github.com/${REPOSITORY}.git`, defaultBranch: "main", settings: {} });
  const macThread = threads.insert(core.db, { projectId: macProject.id, title: "Mac retry fix", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  const macRun = runs.insert(core.db, { id: "mac-run", taskId: null, threadId: macThread.id, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  const mac = { projectId: macProject.id, threadId: macThread.id, runId: macRun.id };

  await core.remote.attach((request, origin) => core.handle(request, origin));
  await core.remote.configure(true);
  const window = rpcClient(() => core);
  await window("account.signIn", {});
  await vi.waitFor(async () => expect(await window("spaces.status", {})).toMatchObject({ state: "ready" }), { timeout: 5_000 });
  await vi.waitFor(async () => expect((await window("threads.list", { spaceId: birch })).map((row) => row.id)).toContain(cloud.threads.teammate), { timeout: 5_000 });

  const phones: RemoteTestClient[] = [];
  /** A paired phone whose session asks for `capabilities`; null never asks, as the first builds. */
  async function phone(capabilities: string[] | null): Promise<RemoteTestClient> {
    const paired = await RemoteTestClient.pair((await core.remote.beginPairing()).url);
    if (typeof paired === "string") throw new Error(paired);
    phones.push(paired);
    if (capabilities) await paired.request("session.negotiate", { capabilities });
    return paired;
  }

  /**
   * A second Mac signed in as Mara, for what only Birch Studio's admin can change, or what she does in a cloud thread.
   * `inThread`: the cloud thread the work acts in, which her Mac must have heard first, as her app lists a thread
   * before she can act in it; her spaces are ready before her threads are heard.
   */
  async function asMara<T>(work: (mara: ReturnType<typeof rpcClient>) => Promise<T>, inThread?: string): Promise<T> {
    let maraToken: string | null = null;
    const admin = await OpenOrc.create({
      dataDir: path.join(folder, `mara-${Date.now()}`),
      ephemeral: true,
      transport: { push() {} },
      accountServer: stand.url,
      accountSecrets: { load: async () => maraToken, save: async (value) => void (maraToken = value) },
      openBrowser: (url) => void fetch(stand.signInPage(url, MARA)),
    });
    try {
      const mara = rpcClient(() => admin);
      await mara("account.signIn", {});
      await vi.waitFor(async () => expect(await mara("spaces.status", {})).toMatchObject({ state: "ready" }), { timeout: 5_000 });
      if (inThread) await vi.waitFor(async () => expect(await mara("threads.get", { id: inThread })).toMatchObject({ owner: { brain: "hosted" } }), { timeout: 5_000 });
      return await work(mara);
    } finally {
      await admin.close();
    }
  }

  return {
    stand,
    core,
    window,
    windowPushes,
    cloud,
    mac,
    phone,
    asMara,
    async close() {
      phones.forEach((each) => each.close());
      await core.close();
      await stand.close();
      await rm(folder, { recursive: true, force: true });
    },
  };
}
export type CloudMac = Awaited<ReturnType<typeof cloudMac>>;
