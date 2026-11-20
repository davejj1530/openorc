import { cleanup, render } from "@testing-library/react";
import type { ThreadAuthors } from "@openorc/protocol";
import { afterEach, expect, it } from "vitest";
import { ConversationVoice } from "../lib/turn-authors";
import { ThreadVoicesContext } from "../lib/thread-authors";
import { TurnHead } from "./TurnHead";

afterEach(cleanup);

const voice = { authors: new Map([["guest", "Rini"]]), runs: new Map([["run", { agent: "codex", model: "GPT-6-Astra" }]]) };
const mara = { id: "u-mara", name: "Mara Okafor", image: null };
const theo = { id: "u-theo", name: "Theo Laurent", image: null };

const head = (props: Partial<Parameters<typeof TurnHead>[0]>, together?: { authors: ThreadAuthors; live?: typeof mara }) =>
  render(
    <ConversationVoice.Provider value={voice}>
      <ThreadVoicesContext.Provider value={together ? { ...together, shared: true } : null}>
        <TurnHead runId="run" voiced={false} live={false} {...props} />
      </ThreadVoicesContext.Provider>
    </ConversationVoice.Provider>,
  ).container;

it("names the agent on a turn where it changed, and never its model", () => {
  expect(head({ voiced: true }).textContent).toBe("Codex");
});

it("draws nothing on a turn whose agent did not change", () => {
  expect(head({}).querySelector(".turn-head")).toBeNull();
});

it("gives a guest Orcling's run its byline", () => {
  expect(head({ runId: "guest", voiced: true }).textContent).toBe("Rini");
});

it("names the live turn's sender as the server does before its prompt says who wrote it", () => {
  const authors: ThreadAuthors = { viewer: theo, turnOf: {}, senders: {}, authors: {} };
  expect(head({ live: true, blocks: [{ id: "user-prompt" }], prompt: "user-prompt" }, { authors, live: mara }).textContent).toBe("MOMara");
  cleanup();
  expect(head({ blocks: [{ id: "user-prompt" }], prompt: "user-prompt" }, { authors, live: mara }).querySelector(".turn-head")).toBeNull();
});

it("leaves the sender to the prompt above that names them, and names one the prompt does not", () => {
  const authors: ThreadAuthors = { viewer: theo, turnOf: { joined: "t1", reply: "t1" }, senders: { t1: mara }, authors: { joined: mara } };
  expect(head({ blocks: [{ id: "joined" }, { id: "reply" }], prompt: "joined" }, { authors }).querySelector(".turn-head")).toBeNull();
  cleanup();
  const joined = { ...authors, authors: { joined: theo } };
  expect(head({ voiced: true, blocks: [{ id: "joined" }, { id: "reply" }], prompt: "joined" }, { authors: joined }).textContent).toBe("Codex" + "MOMara");
});
