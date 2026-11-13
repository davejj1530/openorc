import { expect, it } from "vitest";
import { steerOpenCode } from "./steer.js";

it("admits the message into the running turn through OpenCode's own server, by the ACP session's id", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return JSON.stringify({ data: { id: "msg_1", sessionID: "ses_1", type: "user", payload: { text: "Also check the tests." }, delivery: "steer" } });
  };
  expect(await steerOpenCode(run, "ses_1", "Also check the tests.")).toBe("accepted");
  expect(calls).toEqual([["api", "session.prompt", "--param", "sessionID=ses_1", "--data", JSON.stringify({ text: "Also check the tests.", delivery: "steer" })]]);
});

it("hands pictures over by path, which OpenCode reads itself, so a large one never goes on the command line", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    return JSON.stringify({ data: { delivery: "steer" } });
  };
  expect(await steerOpenCode(run, "ses_1", "What's in this?", ["/Users/me/Desktop/shot one.png"])).toBe("accepted");
  expect(JSON.parse(calls[0]!.at(-1)!)).toEqual({ text: "What's in this?", files: [{ uri: "file:///Users/me/Desktop/shot%20one.png", name: "shot one.png" }], delivery: "steer" });
});

it("says the turn didn't take it when OpenCode queued it instead, and says why when OpenCode refused", async () => {
  expect(await steerOpenCode(async () => JSON.stringify({ data: { delivery: "queue" } }), "ses_1", "Later.")).toBe("unavailable");
  await expect(
    steerOpenCode(
      async () => {
        throw new Error("Session not found: ses_1");
      },
      "ses_1",
      "Hello",
    ),
  ).rejects.toThrow("OpenCode did not take the message: Session not found: ses_1");
});
