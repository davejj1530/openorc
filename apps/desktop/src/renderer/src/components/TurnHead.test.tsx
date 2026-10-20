import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ConversationVoice } from "../lib/turn-authors";
import { TurnHead } from "./TurnHead";

afterEach(cleanup);

const voice = { authors: new Map([["guest", "Rini"]]), runs: new Map([["run", { agent: "codex", model: "GPT-6-Astra" }]]) };
const head = (runId: string, status: Parameters<typeof TurnHead>[0]["status"]) =>
  render(
    <ConversationVoice.Provider value={voice}>
      <TurnHead runId={runId} status={status} />
    </ConversationVoice.Provider>,
  ).container.querySelector(".turn-head")!;

it("names the agent and model, then the turn's time once it is done", () => {
  expect(head("run", { kind: "done", elapsed: 72_000 }).textContent).toBe("CodexGPT-6-Astra · 1m 12s");
});

it("counts up while the turn works and says when it is writing", () => {
  expect(head("run", { kind: "working", elapsed: 48_000 }).textContent).toBe("CodexGPT-6-Astra · working 48s");
  cleanup();
  expect(head("run", { kind: "writing", elapsed: 50_000 }).textContent).toBe("CodexGPT-6-Astra · Writing");
});

it("keeps a failed or stopped turn's outcome in the head", () => {
  expect(head("run", { kind: "failed", elapsed: 12_000 }).textContent).toBe("CodexGPT-6-Astra · Failed after 12s");
  cleanup();
  expect(head("run", { kind: "stopped" }).textContent).toBe("CodexGPT-6-Astra · Stopped");
});

it("gives a guest Orcling's run its byline", () => {
  expect(head("guest", { kind: "done" }).textContent).toBe("Rini");
});
