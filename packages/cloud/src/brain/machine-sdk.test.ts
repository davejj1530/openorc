import { beforeEach, expect, it, vi } from "vitest";

/** What the SDK was asked: a looked-up brain must only ever be reached through the session it was found in. */
const calls: string[] = [];

vi.mock("@vercel/sandbox", () => {
  const session = {
    readFileToBuffer: async ({ path }: { path: string }) => (calls.push(`session read ${path}`), Buffer.from("package")),
    writeFiles: async (files: { path: string }[]) => void calls.push(...files.map((file) => `session write ${file.path}`)),
    runCommand: async () => {
      calls.push("session run");
      return {
        wait: async () => ({ exitCode: 0, stdout: async () => '{"ok":true,"result":{"received":true}}\n', stderr: async () => "" }),
        logs: async function* () {},
        writeStdin: async () => undefined,
        closeStdin: async () => undefined,
      };
    },
  };
  const sandbox = {
    cwd: "/vercel/sandbox",
    status: "running",
    routes: [],
    currentSession: () => session,
    // The sandbox's own calls resume a stopped sandbox: a looked-up brain must never use them.
    readFileToBuffer: async () => (calls.push("resuming read"), Buffer.from("package")),
    writeFiles: async () => void calls.push("resuming write"),
    runCommand: async () => (calls.push("resuming run"), session.runCommand()),
  };
  class APIError extends Error {
    response = { status: 500 };
  }
  return { APIError, Sandbox: { get: async () => sandbox } };
});
vi.mock("../vercel-projects.js", () => ({ findVercelProject: async () => ({ id: "prj_brain" }), ensureVercelProject: async () => ({ id: "prj_brain" }) }));

beforeEach(() => {
  calls.length = 0;
});

it("reads and writes a looked-up brain's files only through the session it runs in", async () => {
  const { BrainMachine } = await import("./machine.js");
  const brain = (await BrainMachine.find({ service: "vercel", token: "t", teamId: "team_1" }))!;
  expect(Buffer.from(await brain.readOutbox("r.thread")).toString()).toBe("package");
  await brain.receiveThread("r", Buffer.from("package")).catch(() => undefined);
  expect(calls.filter((call) => call.startsWith("resuming"))).toEqual([]);
  expect(calls).toContain("session read /vercel/sandbox/openorc-brain/outbox/r.thread");
  expect(calls).toContain("session write /vercel/sandbox/openorc-brain/inbox/r.thread");
});
