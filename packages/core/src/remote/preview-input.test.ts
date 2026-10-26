import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewCaptureOptions, PreviewHost, PreviewHostCapture, PreviewHostInput, PreviewHostPage, PreviewInputRequest, RemotePush, SessionParams } from "@openorc/protocol";
import { PreviewCasters, type PreviewSession } from "./preview-casters.js";

/** A Mac whose page changes only when a phone's input lands on it, as a still page that a tap repaints does. */
class FakeMac implements PreviewHost {
  page: PreviewHostPage | null = { pane: "0123456789ab", url: "http://127.0.0.1:47831/buttons", title: "QA Buttons", loading: false, error: null, crashed: false };
  version = 1;
  answer: PreviewHostInput = { kind: "applied", focus: null };
  readonly captures: number[] = [];
  readonly inputs: { at: number; threadId: string; request: PreviewInputRequest }[] = [];
  query = vi.fn(async () => this.page);
  async capture(_threadId: string, options: PreviewCaptureOptions): Promise<PreviewHostCapture | null> {
    this.captures.push(Date.now());
    if (!this.page) return null;
    const digest = `d${this.version}`;
    if (digest === options.unless) return { kind: "same" };
    return { kind: "frame", pane: this.page.pane, jpeg: new Uint8Array([this.version]), width: options.width, height: 566, digest };
  }
  async input(threadId: string, request: PreviewInputRequest): Promise<PreviewHostInput | null> {
    this.inputs.push({ at: Date.now(), threadId, request });
    if (!this.page) return null;
    if (this.answer.kind === "applied") this.version++;
    return this.answer;
  }
  onChange() {
    return () => undefined;
  }
  threadGone() {}
}

class FakePhone implements PreviewSession {
  readonly told: { seq: number; at: number }[] = [];
  push(push: RemotePush) {
    if (push.type === "preview" && push.state.open && push.state.frame) this.told.push({ seq: push.state.frame.seq, at: Date.now() });
  }
}

let mac: FakeMac;
let casters: PreviewCasters;
const words = (message: string) => message.replace("ghp_", "[token]");

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  mac = new FakeMac();
  casters = new PreviewCasters({ host: mac, words, roots: () => ({ home: "/Users/me", dataDir: "/Users/me/.openorc", projects: [] }) });
});

afterEach(() => {
  casters.close();
  vi.useRealTimers();
});

const lan = { threadId: "t1", width: 786, pace: "lan" as const };
const tap = (overrides: Partial<SessionParams<"preview.input">> = {}): SessionParams<"preview.input"> => ({
  threadId: "t1",
  pane: "0123456789ab",
  frame: { width: 786, height: 566 },
  input: { kind: "tap", x: 393, y: 283, count: 1 },
  ...overrides,
});
/** Watches, fetching every frame it hears of, until the page has been still long enough to idle at 2 s. */
async function watchedStill(phone: FakePhone) {
  await casters.watch(phone, lan);
  const each = fetchEach(phone);
  await run(6_000, each);
  return each;
}
function fetchEach(phone: FakePhone) {
  let seen = 0;
  return () => {
    for (const { seq } of phone.told.slice(seen)) casters.frame(phone, "t1", seq);
    seen = phone.told.length;
  };
}
async function run(ms: number, each?: () => void, step = 10) {
  for (let left = ms; left > 0; left -= step) {
    await vi.advanceTimersByTimeAsync(step);
    each?.();
  }
}
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => "applied",
    (error: Error) => error.message,
  );

describe("a phone's input on the Preview it watches", () => {
  it("reaches main for the watched thread's shown pane, with the frame its points are in", async () => {
    const phone = new FakePhone();
    await watchedStill(phone);
    expect(await casters.input(phone, tap())).toEqual({ focus: null });
    expect(mac.inputs.map(({ threadId, request }) => ({ threadId, request }))).toEqual([
      { threadId: "t1", request: { pane: "0123456789ab", frame: { width: 786, height: 566 }, input: { kind: "tap", x: 393, y: 283, count: 1 } } },
    ]);
  });

  it("is refused from a session that does not watch that thread, and never reaches main", async () => {
    const phone = new FakePhone();
    const stranger = new FakePhone();
    await watchedStill(phone);
    await casters.watch(new FakePhone(), { ...lan, threadId: "t2" });
    expect(await refusal(casters.input(stranger, tap()))).toBe("This page is not being watched.");
    expect(await refusal(casters.input(phone, tap({ threadId: "t2" })))).toBe("This page is not being watched.");
    casters.unwatch(phone);
    expect(await refusal(casters.input(phone, tap()))).toBe("This page is not being watched.");
    expect(mac.inputs).toEqual([]);
  });

  it("is dropped when it names a pane the Mac no longer shows, so a tab switch mid-gesture never lands on the other tab", async () => {
    const phone = new FakePhone();
    await watchedStill(phone);
    expect(await refusal(casters.input(phone, tap({ pane: "ffffffffffff" })))).toBe("The page changed.");
    expect(mac.inputs).toEqual([]);
    // Main is the authority: the core's state can lag a tab switch it has not heard of yet.
    mac.answer = { kind: "refused", reason: "pane" };
    expect(await refusal(casters.input(phone, tap()))).toBe("The page changed.");
    mac.answer = { kind: "refused", reason: "busy" };
    expect(await refusal(casters.input(phone, tap()))).toBe("The agent is using this page.");
    mac.answer = { kind: "refused", reason: "stuck" };
    expect(await refusal(casters.input(phone, tap()))).toBe("The page is not responding.");
    mac.page = null;
    expect(await refusal(casters.input(phone, tap()))).toBe("Preview is closed.");
  });

  it("answers the Mac's focus, a select's labels in the phone's words", async () => {
    const phone = new FakePhone();
    await watchedStill(phone);
    mac.answer = { kind: "applied", focus: { kind: "choice", options: [{ label: "Plan ghp_x", disabled: false }], selected: 0 } };
    expect(await casters.input(phone, tap())).toEqual({ focus: { kind: "choice", options: [{ label: "Plan [token]x", disabled: false }], selected: 0 } });
    const field = { kind: "text", keyboard: "email", enter: "go", secure: false, multiline: false } as const;
    mac.answer = { kind: "applied", focus: field };
    expect(await casters.input(phone, tap())).toEqual({ focus: field });
  });

  it("allows 30 inputs in any second per session, then refuses until the second has passed", async () => {
    const phone = new FakePhone();
    const other = new FakePhone();
    await watchedStill(phone);
    await casters.watch(other, lan);
    const answers = await Promise.all(Array.from({ length: 35 }, () => refusal(casters.input(phone, tap()))));
    expect(answers.filter((answer) => answer === "applied")).toHaveLength(30);
    expect(answers.slice(30)).toEqual(Array(5).fill("Too many inputs at once."));
    expect(mac.inputs).toHaveLength(30);
    expect(await refusal(casters.input(other, tap()))).toBe("applied");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await refusal(casters.input(phone, tap()))).toBe("applied");
  });
});

describe("the frame after an input", () => {
  it("is captured 60 ms after main applied it, not at the idle interval, and reaches the phone", async () => {
    const phone = new FakePhone();
    const each = await watchedStill(phone);
    const told = phone.told.length;
    await casters.input(phone, tap());
    const applied = Date.now();
    await run(300, each);
    expect(mac.captures.find((at) => at > applied)! - applied).toBe(60);
    expect(phone.told.slice(told).map(({ at }) => at - applied)).toEqual([60]);
  });

  it("keeps an interactive pace while input continues: a frame every 200 ms on LAN, back to idle 2 s after the last", async () => {
    const phone = new FakePhone();
    const each = await watchedStill(phone);
    const start = phone.told.length;
    // A drag: an input every 50 ms for 2 s, each repainting the page.
    for (let i = 0; i < 40; i++) {
      void casters.input(phone, { ...tap(), input: { kind: "scroll", x: 393, y: 283, dx: 0, dy: -20 } });
      await run(50, each);
    }
    const dragged = phone.told.slice(start);
    const gaps = dragged.slice(1).map((frame, i) => frame.at - dragged[i]!.at);
    expect(dragged.length).toBeGreaterThanOrEqual(9);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(150);
    const last = mac.inputs.at(-1)!.at;
    await run(2_000, each);
    const interactive = mac.captures.filter((at) => at > last && at <= last + 2_000);
    expect(interactive.length).toBeGreaterThanOrEqual(8);
    await run(4_000, each);
    const idle = mac.captures.filter((at) => at > last + 2_200);
    expect(idle.length).toBeLessThanOrEqual(4);
  });

  it("stays at the lean pace's interactive step on a tailnet route", async () => {
    const phone = new FakePhone();
    await casters.watch(phone, { ...lan, pace: "tailnet" });
    const each = fetchEach(phone);
    await run(6_000, each);
    const start = phone.told.length;
    for (let i = 0; i < 40; i++) {
      void casters.input(phone, { ...tap(), input: { kind: "scroll", x: 393, y: 283, dx: 0, dy: -20 } });
      await run(50, each);
    }
    const dragged = phone.told.slice(start);
    const gaps = dragged.slice(1).map((frame, i) => frame.at - dragged[i]!.at);
    expect(dragged.length).toBeGreaterThanOrEqual(4);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(450);
  });
});
