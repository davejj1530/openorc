import { describe, expect, it } from "vitest";
import { turnShowsSender, turnShowsVoice } from "./turn-voice.js";

const opus = { agent: "claude", model: "Opus 5.5" };

describe("turnShowsVoice", () => {
  it("names no turn of a thread that stays on one agent and model", () => {
    expect(turnShowsVoice(opus, { ...opus })).toBe(false);
  });

  it("names the turn where the model, the agent or the guest speaking changed", () => {
    expect(turnShowsVoice({ ...opus, model: "Sonnet 5.5" }, opus)).toBe(true);
    expect(turnShowsVoice({ agent: "codex", model: "Opus 5.5" }, opus)).toBe(true);
    expect(turnShowsVoice({ ...opus, byline: "Rini" }, opus)).toBe(true);
    expect(turnShowsVoice(opus, { ...opus, byline: "Rini" })).toBe(true);
  });

  it("names nothing it cannot compare", () => {
    expect(turnShowsVoice(undefined, opus)).toBe(false);
    expect(turnShowsVoice(opus, undefined)).toBe(false);
  });
});

describe("turnShowsSender", () => {
  const mara = { id: "u-mara", name: "Mara Okafor", image: null };
  const theo = { id: "u-theo", name: "Theo Laurent", image: null };

  it("leaves the sender to the prompt that already names them", () => {
    expect(turnShowsSender(mara, mara)).toBe(false);
    expect(turnShowsSender(null, null)).toBe(false);
  });

  it("names the sender a teammate's prompt or a missing prompt does not", () => {
    expect(turnShowsSender(mara, theo)).toBe(true);
    expect(turnShowsSender(mara, undefined)).toBe(true);
    expect(turnShowsSender(null, theo)).toBe(true);
  });

  it("names nobody in a thread that does not know its senders", () => {
    expect(turnShowsSender(undefined, mara)).toBe(false);
  });
});
