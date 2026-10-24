import { planSubmit, type SubmitInput } from "@openorc/client";
import { describe, expect, it } from "vitest";
import { composerControls, type ComposerState } from "./composer-state";

const idle: ComposerState = { text: "", attachments: 0, uploading: 0, sending: false, disabledReason: null, working: false, steerable: false, stoppable: false, stopping: false };
const run = { id: "run-1", agent: "codex", mode: "act", permissionMode: "trusted" } as const;
const conversation: SubmitInput = {
  target: { kind: "thread", threadId: "t" },
  working: false,
  live: true,
  activeRun: run,
  agentsUsed: ["codex"],
  choice: { agent: "codex", model: "gpt", effort: null },
  mode: "act",
  permission: "trusted",
  permissionReady: true,
  compacting: false,
  now: false,
};

/** What pressing a control does: the composer decides `now`, the shared send tree decides the call. */
const press = (state: ComposerState, control: "primary" | "queue", input: Partial<SubmitInput> = {}) => {
  const controls = composerControls(state);
  const now = control === "primary" ? controls.sendsNow : false;
  return planSubmit({ ...conversation, working: state.working, ...input, now }).kind;
};

describe("composerControls", () => {
  it("sends once something is written, and only then", () => {
    expect(composerControls(idle)).toMatchObject({ primary: "send", canSend: false, primaryEnabled: false, queue: false, stop: false });
    expect(composerControls({ ...idle, text: "  " }).canSend).toBe(false);
    expect(composerControls({ ...idle, text: "Run the tests" })).toMatchObject({ primary: "send", canSend: true, primaryEnabled: true });
    expect(composerControls({ ...idle, attachments: 1 }).canSend).toBe(true);
  });

  it("continues the warm process between turns", () => {
    expect(press({ ...idle, text: "Next" }, "primary")).toBe("continue");
    expect(press({ ...idle, text: "Next" }, "primary", { live: false })).toBe("start");
  });

  it("turns the main pill into Stop while a turn runs with nothing written", () => {
    const working = { ...idle, working: true, stoppable: true, steerable: true };
    expect(composerControls(working)).toMatchObject({ primary: "stop", primaryEnabled: true, stop: false, queue: false });
    expect(composerControls({ ...working, stopping: true }).primaryEnabled).toBe(false);
  });

  it("sends into the running turn when it can take it, with Queue and Stop beside the pill", () => {
    const steering = { ...idle, text: "Also check the docs", working: true, stoppable: true, steerable: true };
    expect(composerControls(steering)).toMatchObject({ primary: "send", sendsNow: true, queue: true, stop: true });
    expect(press(steering, "primary")).toBe("steer");
    expect(press(steering, "queue")).toBe("queue");
  });

  it("queues from the main pill when the turn cannot take a message", () => {
    const busy = { ...idle, text: "After this", working: true, stoppable: true, steerable: false };
    expect(press(busy, "primary", { live: false })).toBe("queue");
    expect(press(busy, "primary", { activeRun: { ...run, agent: "opencode" }, choice: { agent: "opencode", model: "m", effort: null } })).toBe("queue");
  });

  it("holds the send while an image uploads, a send is on its way, or a reason blocks it", () => {
    const draft = { ...idle, text: "Look" };
    expect(composerControls({ ...draft, uploading: 1 }).canSend).toBe(false);
    expect(composerControls({ ...draft, sending: true }).canSend).toBe(false);
    expect(composerControls({ ...draft, disabledReason: "Choose a model" }).canSend).toBe(false);
    expect(composerControls({ ...idle, uploading: 1, working: true, stoppable: true })).toMatchObject({ primary: "send", stop: true });
  });
});
