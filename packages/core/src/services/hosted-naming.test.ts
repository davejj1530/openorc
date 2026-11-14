import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { standIn, type StandIn } from "@openorc/hosted/testing";
import { WORKSPACE_ID } from "@openorc/protocol";
import { threads } from "@openorc/db";
import { OpenOrc } from "../openorc.js";
import { rpcClient } from "../rpc-test-client.js";

const SELF = "alex@example.com";
const PROMPT = "Add CSV export\nwith filters";
let folder: string;
let stand: StandIn;
let core: OpenOrc;
let id: string;
const call = rpcClient(() => core);

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "openorc-thread-naming-"));
  stand = await standIn({ signup: "open" });
  const project = stand.addProject(SELF, { name: "Canvas", fullName: "example/canvas" });
  id = stand.addThread(SELF, { projectId: project, title: "", status: "working", agent: "codex" });
  let stored = "";
  core = await OpenOrc.create({
    dataDir: folder,
    ephemeral: true,
    transport: { push: () => undefined },
    accountServer: stand.url,
    accountSecrets: { load: async () => stored, save: async (value) => void (stored = value) },
    shellProbe: async () => ({
      path: process.env.PATH ?? "",
      binaries: {
        claude: "/usr/bin/false",
        codex: "/usr/bin/false",
        opencode: "/usr/bin/false",
        omp: "/usr/bin/false",
        cursor: "/usr/bin/false",
        pi: "/usr/bin/false",
        antigravity: "/usr/bin/false",
        fx: "/usr/bin/false",
      },
    }),
    openBrowser: (url) => void fetch(stand.signInPage(url, SELF), { redirect: "manual" }),
  });
});
afterEach(async () => {
  await core.close();
  await stand.close();
  await rm(folder, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function signIn() {
  await call("account.signIn", {});
  await vi.waitFor(async () => expect(await call("threads.get", { id })).toMatchObject({ title: "New thread" }));
}
function finish() {
  stand.append(id, [{ type: "message.completed", ts: Date.now(), messageId: "first", role: "user", text: PROMPT }], { by: `user-${SELF}` });
  stand.append(id, [{ type: "message.completed", ts: Date.now(), messageId: "answer", role: "assistant", text: "Export follows the filters." }]);
  stand.endTurn(id);
}

it("routes hosted first exchanges through the same text-generation service as local threads", async () => {
  const title = vi.spyOn(core.textGeneration, "title").mockResolvedValue("CSV export with filters");
  await signIn();
  finish();
  await vi.waitFor(async () => expect(await call("threads.get", { id })).toMatchObject({ title: "CSV export with filters" }));
  expect(title).toHaveBeenCalledOnce();
  expect(title).toHaveBeenCalledWith({ request: PROMPT, reply: "Export follows the filters." }, "codex", "claude-cli");
});

it("uses one eligibility rule for explicit names and failed or unavailable generation", async () => {
  const title = vi.spyOn(core.textGeneration, "title").mockResolvedValue(null);
  await signIn();
  await call("threads.update", { id, patch: { title: "Quarterly export" } });
  finish();
  await vi.waitFor(async () => expect((await call("threads.get", { id }))?.activity).toBe("idle"));
  expect(title).not.toHaveBeenCalled();
  expect(await call("threads.get", { id })).toMatchObject({ title: "Quarterly export" });
});

it("preserves a local rename while the shared naming service waits", async () => {
  let resolve = (_title: string | null) => {};
  const pending = new Promise<string | null>((done) => {
    resolve = done;
  });
  const title = vi.spyOn(core.textGeneration, "title").mockReturnValue(pending);
  const thread = threads.insert(core.db, { projectId: WORKSPACE_ID, title: "Add CSV export", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  const naming = core.threads.onTurnCompleted(thread, { prompt: PROMPT, reply: "Done" });
  await vi.waitFor(() => expect(title).toHaveBeenCalledOnce());
  threads.update(core.db, thread.id, { title: "Quarterly export" });
  resolve("CSV export with filters");
  await naming;
  expect(threads.get(core.db, thread.id)).toMatchObject({ title: "Quarterly export" });
});
