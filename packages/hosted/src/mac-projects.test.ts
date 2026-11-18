import { describe, expect, it } from "vitest";
import { leaveWithSave, SaveNotMade, type SaveAsking, type WireWorkSave } from "./mac-projects.js";
import { Refused } from "./session.js";

const SAVED = { branch: "openorc/fix", head: "b", base: "a", bundle: true, uncommitted: false, savedAt: "2026-11-18T10:00:00.000Z" };

/**
 * A thread's server as a wait for its save meets it: answers to GET work-save in turn (the last one stands), and how it
 * answers each POST ask, with what was asked and taken back.
 */
function server(answers: Partial<WireWorkSave>[], asks: ({ asked: boolean } | "turn")[]) {
  const said: string[] = [];
  let at = 0;
  let clock = 0;
  const calls: SaveAsking = {
    workSave: async () => ({ save: SAVED, current: false, working: false, ends: [], ...answers[Math.min(at++, answers.length - 1)] }),
    ask: async () => {
      const answer = asks.shift() ?? { asked: true };
      said.push(answer === "turn" ? "ask refused" : "ask");
      if (answer === "turn") throw new Refused("The agent is still working. Bring its work once it stops.", 409);
      return answer;
    },
    withdraw: async () => void said.push("withdraw"),
    now: () => clock,
    pause: async (ms) => void (clock += ms),
  };
  return { calls, said };
}

describe("a wait for a thread to leave its machine with a save", () => {
  it("asks nothing when the newest save is current and none is asked for", async () => {
    const { calls, said } = server([{ current: true }], []);
    expect(await leaveWithSave(calls, 60_000)).toMatchObject({ current: true });
    expect(said).toEqual([]);
  });

  it("waits for a running turn to end before it asks, and is done once the save asked for is made, current or not", async () => {
    // The turn runs, ends; the ask is taken; the save is made while a new message keeps the folder in use.
    const { calls, said } = server([{ working: true }, { working: true }, { working: false }, { asked: true }, { asked: false, current: false, working: true }], []);
    expect(await leaveWithSave(calls, 60_000)).toMatchObject({ asked: false, current: false });
    expect(said).toEqual(["ask"]);
  });

  it("asks again when the server refuses because a turn began beneath the ask", async () => {
    const { calls, said } = server([{}, {}, { asked: true }, { asked: false, current: true }], ["turn", { asked: true }]);
    expect(await leaveWithSave(calls, 60_000)).toMatchObject({ current: true });
    expect(said).toEqual(["ask refused", "ask"]);
  });

  it("waits on a server from before `asked` until the save is current", async () => {
    const { calls } = server([{}, {}, { current: true }], []);
    expect(await leaveWithSave(calls, 60_000)).toMatchObject({ current: true });
  });

  it("gives up after its time and takes back the ask, saying whether the turn still runs", async () => {
    const asked = server([{}, { asked: true }], []);
    await expect(leaveWithSave(asked.calls, 5_000)).rejects.toThrow("The thread didn't save its work in time. Try again.");
    expect(asked.said).toEqual(["ask", "withdraw"]);
    const turn = server([{ working: true }], []);
    await expect(leaveWithSave(turn.calls, 5_000)).rejects.toEqual(new SaveNotMade(true));
    expect(turn.said).toEqual([]);
  });

  it("passes on a refusal that isn't a running turn, in its words", async () => {
    const { calls } = server([{}], []);
    calls.ask = async () => {
      throw new Refused("Only someone in the thread can do that.", 403);
    };
    await expect(leaveWithSave(calls, 60_000)).rejects.toThrow("Only someone in the thread can do that.");
  });
});
