import { hostedRunId, type AgentEvent } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHosted, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

/*
 * A start's steps, as the server writes them while a message waits on its machine: ordinary work rows in the thread's
 * log, each named by the message that started it, so every app and phone draws them, and a later start's are its own.
 */
const ADA = "ada@example.com";
let stand: StandIn;
const hosts: Hosted[] = [];

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  stand.setBilling(ADA, { pro: true, standing: "live", at: new Date(Date.now() + 20 * 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
  stand.setSignIns(ADA, [{ agent: "codex" }]);
});
afterEach(async () => {
  for (const hosted of hosts.splice(0)) hosted.close();
  await stand.close();
});

it("draws a start's steps as work rows of their own, done or failed in the server's words", async () => {
  const project = stand.addProject(ADA, { name: "launch", fullName: "acme/launch" });
  const thread = stand.addThread(ADA, { projectId: project, title: "Plan the launch", agent: "codex" });
  const { deps, browser } = hostDeps(stand, newDevice());
  const hosted = createHosted(deps);
  hosts.push(hosted);
  await hosted.start();
  await signInAs(hosted, browser, ADA);
  await vi.waitFor(() => expect(hosted.threads.holds({ thread })).toBe(true));
  stand.startStep(thread, "m1", "machine", "running");
  stand.startStep(thread, "m1", "machine", "success");
  stand.startStep(thread, "m1", "agent", "success");
  stand.startStep(thread, "m2", "machine", "error", "The machine didn't start. Try again.");
  const steps = async () =>
    (await hosted.threads.call("events.page", { runId: hostedRunId(thread), turns: 10 })).events.flatMap((event: AgentEvent) =>
      event.type === "activity.updated" ? [[event.activityId, event.label, event.status, event.text ?? null]] : [],
    );
  await vi.waitFor(async () =>
    expect(await steps()).toEqual([
      ["start:m1:machine", "Starting the machine", "running", null],
      ["start:m1:machine", "Starting the machine", "success", null],
      ["start:m1:agent", "Starting Codex", "success", null],
      ["start:m2:machine", "Starting the machine", "error", "The machine didn't start. Try again."],
    ]),
  );
});
