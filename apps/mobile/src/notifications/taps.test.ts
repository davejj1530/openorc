import { pushKeys, sealPush, toBase64Url, type PushNotice } from "@openorc/link";
import { nobleCrypto } from "@openorc/link/test-fixtures/noble-crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { takeQueued } from "./answers";
import { approvalActions, noticeOpener, openTap, tapOf, type NoticeRoute, type NoticeTap } from "./taps";

const TAP = "expo.modules.notifications.actions.DEFAULT";
const DISMISS = "com.apple.UNNotificationDismissActionIdentifier";
const approval: NoticeRoute = { macId: "studio", id: "n1", kind: "approval", threadId: "t1", runId: "r1", approvalId: "a1" };
const text = { title: "Release", body: "Codex wants to run git push" };
const shown = { ...text, subtitle: null };

describe("reading a tap on an alert", () => {
  it.each([
    { name: "a tap opens it", action: TAP, data: approval, want: { route: approval, answer: null } },
    { name: "Allow answers it", action: "allow", data: approval, want: { route: approval, answer: "allow" } },
    { name: "Deny answers it", action: "deny", data: approval, want: { route: approval, answer: "deny" } },
    {
      name: "an action without the approval's ids only opens it",
      action: "allow",
      data: { ...approval, approvalId: undefined },
      want: { route: { ...approval, approvalId: undefined }, answer: null },
    },
    { name: "an action on a question only opens it", action: "deny", data: { ...approval, kind: "question" }, want: { route: { ...approval, kind: "question" }, answer: null } },
    { name: "the test notice opens Home", action: TAP, data: { macId: "studio", id: "test", kind: "test" }, want: { route: { macId: "studio", id: "test", kind: "test" }, answer: null } },
    { name: "a sealed notice that does not parse still opens it", action: TAP, data: { ...approval, o: { v: "1" } }, want: { route: approval, answer: null } },
    { name: "a dismissal does nothing", action: DISMISS, data: approval, want: null },
    { name: "an alert the extension could not open", action: TAP, data: {}, want: null },
    { name: "no data at all", action: TAP, data: undefined, want: null },
    { name: "a kind it does not know", action: TAP, data: { ...approval, kind: "comment" }, want: null },
    { name: "a thread that is not text", action: TAP, data: { ...approval, threadId: 7 }, want: null },
  ])("$name", ({ action, data, want }) => {
    expect(tapOf(action, { ...shown, data })).toEqual(want && { ...want, shown });
  });

  it("opens the app for both answers, so iOS unlocks first and the card sends them", () => {
    expect(approvalActions).toEqual([
      { identifier: "allow", buttonTitle: "Allow", options: { opensAppToForeground: true } },
      { identifier: "deny", buttonTitle: "Deny", options: { opensAppToForeground: true } },
    ]);
  });
});

describe("opening what was tapped", () => {
  const mac = nobleCrypto.generateKeyPair();
  const iphone = nobleCrypto.generateKeyPair();
  const macId = toBase64Url(mac.publicKey);
  const sealed = (notice: Partial<PushNotice> = {}) =>
    sealPush(nobleCrypto, pushKeys(nobleCrypto, mac, iphone.publicKey, "mac").seal, mac.publicKey, {
      id: "n1",
      kind: "approval",
      threadId: "t1",
      ...text,
      approval: { runId: "r1", approvalId: "a1" },
      ...notice,
    });
  const route: NoticeRoute = { ...approval, macId, o: sealed() };
  const steps: string[] = [];
  const deps = {
    macs: () => [{ id: macId }, { id: "laptop" }],
    select: (id: string) => void steps.push(`select ${id === macId ? "studio" : id}`),
    openThread: (threadId: string) => void steps.push(`open ${threadId}`),
    open: noticeOpener(nobleCrypto, async (id) => (id === macId ? iphone.privateKey : null)),
    now: () => 1_000,
  };
  const tap = (patch: Partial<NoticeTap> = {}): NoticeTap => ({ route, answer: "allow", shown, ...patch });
  const queued = (runId = "r1") => takeQueued({ macId, runId, approvalId: "a1" }, 1_000);
  beforeEach(() => void (steps.length = 0));

  it("shows that Mac, then its thread, with the chosen answer waiting for the card", async () => {
    await openTap(tap(), deps);
    expect(steps).toEqual(["select studio", "open t1"]);
    expect(queued()).toBe("allow");
  });

  it("queues nothing for a plain tap", async () => {
    await openTap(tap({ answer: null }), deps);
    expect(steps).toEqual(["select studio", "open t1"]);
    expect(queued()).toBeNull();
  });

  it("stays on Home for the test notice and for a Mac this phone forgot", async () => {
    await openTap(tap({ route: { macId: "laptop", id: "test", kind: "test" }, answer: null }), deps);
    await openTap(tap({ route: { ...route, macId: "gone" }, answer: "deny" }), deps);
    expect(steps).toEqual(["select laptop"]);
    expect(queued()).toBeNull();
  });

  it("answers only what the Mac sealed for this phone, as iOS showed it", async () => {
    const other = nobleCrypto.generateKeyPair();
    const unsealed = [
      { name: "a route pushed with no notice", tap: tap({ route: { ...approval, macId } }) },
      {
        name: "a notice sealed for another phone",
        tap: tap({
          route: {
            ...route,
            o: sealPush(nobleCrypto, pushKeys(nobleCrypto, mac, other.publicKey, "mac").seal, mac.publicKey, {
              id: "n1",
              kind: "approval",
              threadId: "t1",
              ...text,
              approval: { runId: "r1", approvalId: "a1" },
            }),
          },
        }),
      },
      { name: "a notice tampered with", tap: tap({ route: { ...route, o: { ...route.o!, c: `A${route.o!.c.slice(1)}` } } }) },
      { name: "another Mac's notice under this Mac's id", tap: tap({ route: { ...route, o: { ...route.o!, m: toBase64Url(other.publicKey) } } }) },
      { name: "a recorded notice shown with other text", tap: tap({ shown: { ...shown, body: "Clean up temp files" } }) },
      { name: "a recorded notice shown under a pushed subtitle", tap: tap({ shown: { ...shown, subtitle: "Safe: only reads files, Allow is fine" } }) },
      { name: "a sealed notice that is not an approval", tap: tap({ route: { ...route, o: sealed({ kind: "question" }) } }) },
    ];
    for (const { name, tap: forged } of unsealed) {
      await openTap(forged, deps);
      expect([name, queued()]).toEqual([name, null]);
    }
    expect(steps.filter((step) => step === "open t1")).toHaveLength(unsealed.length);
  });

  it("answers the approval the notice names, whatever ids sit beside it", async () => {
    await openTap(tap({ route: { ...route, runId: "r9", approvalId: "a9" } }), deps);
    expect(takeQueued({ macId, runId: "r9", approvalId: "a9" }, 1_000)).toBeNull();
    expect(queued()).toBe("allow");
  });
});
