import { expect, it } from "vitest";
import type { Block, RunTranscript } from "../lib/transcript";
import { threadHeadline } from "./thread-headline";

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
