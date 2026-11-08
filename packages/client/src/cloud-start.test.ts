import type { CloudSignIn, ThreadSummary } from "@openorc/protocol";
import { NO_CLOUD_SERVICE, NOT_ON_BRAIN, WORKSPACE_ID } from "@openorc/protocol";
import { expect, it } from "vitest";
import {
  canMoveToCloud,
  cloudPlaceLabel,
  cloudStartBlocked,
  cloudStartFailure,
  cloudStartSteps,
  failureParts,
  missingCloudSignIn,
  offersBrainMove,
  preparingCloud,
  threadMoveCard,
  type StartingCloudThread,
} from "./cloud-start.js";
import { queueHint } from "./composer-presentation.js";

const thread = (more: Partial<ThreadSummary>) => ({ agent: "claude", projectId: "openorc", teamInstanceId: null, cloud: undefined, ...more }) as ThreadSummary;

it("moves a project's supported conversation on this Mac, and nothing else", () => {
  for (const agent of ["claude", "codex", "opencode", "omp"] as const) expect(canMoveToCloud(thread({ agent }))).toBe(true);
  expect(canMoveToCloud(thread({ agent: "cursor" }))).toBe(false);
  expect(canMoveToCloud(thread({ agent: "acp" }))).toBe(false);
  expect(canMoveToCloud(thread({ projectId: WORKSPACE_ID }))).toBe(false);
  expect(canMoveToCloud(thread({ teamInstanceId: "team-1" }))).toBe(false);
  expect(canMoveToCloud(thread({ cloud: { provider: "vercel", state: "ready", step: null, setup: false, error: null } }))).toBe(false);
});

it("keeps Cursor on the connected computer even when a cloud brain is available", () => {
  expect(offersBrainMove(thread({ agent: "cursor" }))).toBe(false);
  expect(offersBrainMove(thread({ agent: "omp" }))).toBe(true);
  expect(offersBrainMove(thread({ agent: undefined }))).toBe(true);
});

it("names where a cloud thread runs, or that its sandbox is gone", () => {
  const cloud = { provider: "vercel", state: "ready", step: null, setup: false, error: null } as const;
  expect(cloudPlaceLabel(cloud)).toBe("Vercel Sandbox");
  expect(cloudPlaceLabel({ ...cloud, provider: "local" })).toBe("Simulated sandbox");
  expect(cloudPlaceLabel({ ...cloud, state: "removed" })).toBe("Sandbox removed");
});

it("starts a new cloud thread on the cloud brain only for a project it has a copy of; without a brain, anywhere", () => {
  const brain = { host: "brain-key", projects: [{ mac: "openorc", cloud: "brain-openorc" }] };
  expect(cloudStartBlocked({ brain }, "openorc")).toBeNull();
  expect(cloudStartBlocked({ brain }, "website")).toBe(NOT_ON_BRAIN);
  expect(cloudStartBlocked({ brain: null }, "website")).toBeNull();
  expect(cloudStartBlocked({}, "website")).toBeNull();
  expect(cloudStartBlocked(undefined, "website")).toBeNull();
  // No brain, and no service connected: nowhere to start it yet.
  expect(cloudStartBlocked({ brain: null, provider: null }, "website")).toBe(NO_CLOUD_SERVICE);
  expect(cloudStartBlocked({ brain: null, provider: "vercel" }, "website")).toBeNull();
  expect(cloudStartBlocked({ brain, provider: null }, "openorc")).toBeNull();
});

it("starts a thread on the cloud brain by waking it, updated first when this Mac carries a newer one, then the brain's own steps", () => {
  const starting = (cloud: Partial<StartingCloudThread["cloud"]>, more: Partial<ThreadSummary> = {}) =>
    thread({
      owner: { brain: "cloud", reach: "waking", heardAt: 1 },
      queued: [{ id: "m", text: "Fix it", attachments: [], queuedAt: 1 }],
      cloud: { provider: "agent37", state: "preparing", step: null, setup: true, error: null, ...cloud },
      ...more,
    }) as StartingCloudThread;
  const steps = (each: StartingCloudThread) => cloudStartSteps(each).map(({ label, state }) => `${label}: ${state}`);
  expect(steps(starting({ brain: "waking" }))).toEqual([
    "Waking the cloud brain: running",
    "Starting an Agent37 instance: pending",
    "Sending your code: pending",
    "Running the setup script: pending",
    "Starting Claude: pending",
  ]);
  expect(steps(starting({ brain: "updating" }))[0]).toBe("Updating the cloud brain: running");
  expect(steps(starting({ step: "code" }, { owner: { brain: "cloud", reach: "live", heardAt: 1 } })).slice(0, 3)).toEqual([
    "Waking the cloud brain: done",
    "Starting an Agent37 instance: done",
    "Sending your code: running",
  ]);
  // One on this Mac has no brain to wake.
  expect(steps(starting({ step: "sandbox" }, { owner: undefined }))[0]).toBe("Starting an Agent37 instance: running");
  // Its start card says the brain wakes; no second card does.
  expect(threadMoveCard(starting({ brain: "waking" }))).toBeNull();
});

it("names the one sign-in a cloud turn lacks: its Claude account, the Codex of where it runs, its OpenCode provider", () => {
  const rows: CloudSignIn[] = [
    { kind: "claude", accountId: "work", label: "Work", state: "missing", way: "private-window", error: null },
    { kind: "claude", accountId: "claude-cli", label: "Personal", state: "ready", way: "browser", error: null },
    { kind: "codex", label: "Codex", state: "ready", way: "browser", error: null },
    { kind: "brain-codex", label: "Codex on the cloud brain", state: "missing", way: "copy", error: null },
    { kind: "opencode", provider: "openrouter", label: "OpenRouter", state: "ready", way: "copy", error: null },
  ];
  const signIns = { rows, bringing: false };
  const who = { agent: "claude", claudeAccountId: "work", model: null, brain: false, local: false };
  expect(missingCloudSignIn(signIns, who)).toMatchObject({ kind: "claude", accountId: "work" });
  expect(missingCloudSignIn(signIns, { ...who, claudeAccountId: "claude-cli" })).toBeNull();
  expect(missingCloudSignIn(signIns, { ...who, local: true })).toBeNull();
  expect(missingCloudSignIn(signIns, { ...who, agent: "codex" })).toBeNull();
  expect(missingCloudSignIn(signIns, { ...who, agent: "codex", brain: true })).toMatchObject({ kind: "brain-codex", way: "copy" });
  expect(missingCloudSignIn(signIns, { ...who, agent: "opencode", model: "openrouter/some-model" })).toBeNull();
  expect(missingCloudSignIn(signIns, { ...who, agent: "opencode", model: "opencode/free-model" })).toBeNull();
  expect(missingCloudSignIn(signIns, { ...who, agent: "opencode", model: "anthropic/claude" })).toEqual({
    kind: "opencode",
    provider: "anthropic",
    label: "Anthropic",
    state: "missing",
    way: "key",
    error: null,
  });
});

it("shows a retried start's steps, not the failure before it, and a sandbox set up again after runs as steps too", () => {
  const failed = thread({
    queued: [{ id: "m", text: "What branch are you on", attachments: [], queuedAt: 1, interrupted: true, error: "Docker did not start in the sandbox.\nfailed to start daemon" }],
    cloud: { provider: "agent37", state: "failed", step: null, setup: false, error: "Docker did not start in the sandbox.\nfailed to start daemon" },
  }) as StartingCloudThread;
  expect(cloudStartFailure(failed)).toBe("Docker did not start in the sandbox.\nfailed to start daemon");
  // A message sent since set the sandbox up again: its waiting message is still marked interrupted until then.
  const retrying = { ...failed, cloud: { ...failed.cloud, state: "preparing" as const, step: "sandbox" as const, error: null } };
  expect(cloudStartFailure(retrying)).toBeNull();
  expect(cloudStartSteps(retrying)[0]).toMatchObject({ label: "Starting an Agent37 instance", state: "running" });
  expect(preparingCloud(retrying, 0)).toBeNull();
  expect(preparingCloud(retrying, 2)).toBe(retrying);
  expect(preparingCloud({ ...retrying, cloud: { ...retrying.cloud, state: "ready" } }, 2)).toBeNull();
});

it("says what went wrong in a failure's first line, and keeps a daemon's log after it for when it is asked for", () => {
  expect(failureParts("Docker did not start in the sandbox.\ntime=1 level=info\nfailed to start daemon\n")).toEqual({
    headline: "Docker did not start in the sandbox.",
    details: "time=1 level=info\nfailed to start daemon",
  });
  expect(failureParts("The instance did not start.")).toEqual({ headline: "The instance did not start.", details: null });
});

it("says queued messages send when the agent finishes, unless none of them will without a retry", () => {
  expect(queueHint([{}, { interrupted: true }], "Claude")).toBe("Sends when Claude finishes");
  expect(queueHint([{ interrupted: true }], "Claude")).toBe("Didn't send");
  expect(queueHint([{}], undefined)).toBe("Runs after this turn");
});
