import { describe, expect, it } from "vitest";
import type { Block, RunTranscript } from "./transcript.js";
import { threadHeadline } from "./thread-headline.js";

const run = (blocks: Block[]) => ({ blocks }) as RunTranscript;
const user: Block = { id: "u", kind: "message", role: "user", text: "Fix the row", streaming: false };
const edit: Block = { id: "e", kind: "tool", name: "Edit", input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" }, done: true };
const tests: Block = { id: "t", kind: "tool", name: "Bash", input: { command: "pnpm --filter desktop test", description: "Run the desktop tests" }, done: true };

it("says what the agent is waiting on", () => {
  const ask = (approvalKind: string, input: unknown): Block => ({ id: "a", kind: "approval", approvalId: "a", approvalKind, input });
  expect(threadHeadline({ activity: "waiting", unread: false }, run([user, ask("command", { command: "git push origin main" })]))).toEqual({
    text: "Needs approval · git push origin main",
    tone: "attention",
  });
  expect(threadHeadline({ activity: "waiting", unread: false }, run([user, ask("user_input", {})]))?.text).toBe("Has a question for you");
  expect(threadHeadline({ activity: "waiting", unread: false }, undefined)?.text).toBe("Needs you");
});

it("says what the agent is doing while it works", () => {
  expect(threadHeadline({ activity: "running", unread: false }, run([user, { ...tests, done: false }]))).toEqual({ text: "Run the desktop tests", tone: "live" });
  expect(threadHeadline({ activity: "running", unread: false }, undefined)).toEqual({ text: "Working", tone: "live" });
});

it("says what a finished turn came to until the thread is read", () => {
  expect(threadHeadline({ activity: "idle", unread: true }, run([user, edit, tests]))).toEqual({ text: "Done · 1 file changed · tests passed", tone: "done" });
  expect(threadHeadline({ activity: "idle", unread: false }, run([user, edit, tests]))).toBeNull();
  expect(threadHeadline({ activity: "idle", unread: true }, run([user]))).toBeNull();
});

describe("a cloud thread's row while it is set up or moved", () => {
  const message = { id: "m", text: "hi", attachments: [], queuedAt: 1 };
  const cloud = { provider: "agent37" as const, state: "preparing" as const, step: null, setup: false, error: null };
  const starting = { activity: "running" as const, unread: false, agent: "claude" as const, queued: [message], hasStarted: false };
  const onBrain = { brain: "cloud" as const, reach: "live" as const, heardAt: 1 };

  it("says each step of its start, from waking the cloud brain to starting its agent", () => {
    expect(threadHeadline({ ...starting, owner: onBrain, cloud: { ...cloud, brain: "waking" } }, undefined)).toEqual({ text: "Waking the cloud brain", tone: "live" });
    expect(threadHeadline({ ...starting, owner: onBrain, cloud: { ...cloud, brain: "updating" } }, undefined)?.text).toBe("Updating the cloud brain");
    expect(threadHeadline({ ...starting, cloud: { ...cloud, step: "sandbox" } }, undefined)?.text).toBe("Starting an Agent37 instance");
    expect(threadHeadline({ ...starting, cloud: { ...cloud, step: "code" } }, undefined)?.text).toBe("Sending your code");
    expect(threadHeadline({ ...starting, cloud: { ...cloud, state: "ready" } }, undefined)?.text).toBe("Starting Claude");
  });

  it("says when it did not start, and reads as any thread once its agent ran", () => {
    expect(threadHeadline({ ...starting, activity: "idle", cloud: { ...cloud, state: "failed", error: "No Agent37 balance." } }, undefined)).toEqual({
      text: "Didn't start in the cloud",
      tone: "attention",
    });
    expect(threadHeadline({ ...starting, hasStarted: true, cloud: { ...cloud, state: "ready" } }, undefined)).toEqual({ text: "Working", tone: "live" });
  });

  it("says the step of a move, and that a move did not happen", () => {
    expect(threadHeadline({ activity: "idle", unread: false, moving: { to: "cloud", since: 1, step: "sending" }, lastActivityAt: 1 }, undefined)).toEqual({
      text: "Sending it to the cloud",
      tone: "live",
    });
    expect(threadHeadline({ activity: "idle", unread: false, moveRefused: { to: "cloud", reason: "A turn is running.", at: 2 }, lastActivityAt: 1 }, undefined)).toEqual({
      text: "Didn't move",
      tone: "attention",
    });
  });
});
