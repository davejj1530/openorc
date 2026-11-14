import { beforeEach, expect, it } from "vitest";
import { forgetHostedIntent, hostedIntentId } from "./hosted-send-intent";

beforeEach(() => localStorage.clear());

const intent = { text: "Read these", attachments: ["/hosted/files/a/notes.txt"], now: false };

it("names an unchanged retry with the same id, through a reload of the window's storage", async () => {
  const first = await hostedIntentId("draft", intent);
  expect(await hostedIntentId("draft", { ...intent })).toBe(first);
  expect(JSON.parse(localStorage.getItem("openorc.draft.draft.intent")!)).toMatchObject({ id: first });
});

it("gives any change, another draft or a sent message a new id", async () => {
  const first = await hostedIntentId("draft", intent);
  expect(await hostedIntentId("draft", { ...intent, text: "Read these first" })).not.toBe(first);
  const edited = await hostedIntentId("draft", { ...intent, attachments: ["/hosted/files/b/plan.md"] });
  expect(await hostedIntentId("other", { ...intent, attachments: ["/hosted/files/b/plan.md"] })).not.toBe(edited);
  forgetHostedIntent("draft");
  expect(await hostedIntentId("draft", { ...intent, attachments: ["/hosted/files/b/plan.md"] })).not.toBe(edited);
});
