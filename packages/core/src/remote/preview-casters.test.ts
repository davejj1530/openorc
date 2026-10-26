import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewCaptureOptions, PreviewHost, PreviewHostCapture, PreviewHostPage, RemotePush } from "@openorc/protocol";
import { PreviewCasters, type PreviewSession } from "./preview-casters.js";

/** A Mac whose page repaints on demand: each capture is a new frame while `painting`, else the same one. */
class FakeMac implements PreviewHost {
  page: PreviewHostPage | null = { pane: "0123456789ab", url: "http://127.0.0.1:47831/tick?code=abc#t", title: "QA Tick", loading: false, error: null, crashed: false };
  painting = true;
  /** The page stops changing after this many captures. */
  paints = Infinity;
  /** How long each capture takes, in order; the rest answer at once. */
  latencies: number[] = [];
  version = 0;
  readonly captures: { at: number; threadId: string; options: PreviewCaptureOptions }[] = [];
  private listener: ((threadId: string, lifecycle: boolean) => void) | null = null;
  query = vi.fn(async (_threadId: string) => this.page);
  async capture(threadId: string, options: PreviewCaptureOptions): Promise<PreviewHostCapture | null> {
    this.captures.push({ at: Date.now(), threadId, options });
    const latency = this.latencies.shift();
    if (latency) await new Promise((resolve) => setTimeout(resolve, latency));
    if (!this.page) return null;
    if (this.painting && this.captures.length <= this.paints) this.version++;
    const digest = `d${this.version}`;
    if (digest === options.unless) return { kind: "same" };
    return { kind: "frame", pane: this.page.pane, jpeg: new Uint8Array([this.version]), width: options.width, height: Math.round(options.width * 1.32), digest };
  }
  onChange(listener: (threadId: string, lifecycle: boolean) => void) {
    this.listener = listener;
    return () => (this.listener = null);
  }
  change(threadId: string, lifecycle: boolean) {
    this.listener?.(threadId, lifecycle);
  }
  async input() {
    return null;
  }
  threadGone() {}
}

class FakePhone implements PreviewSession {
  readonly pushes: Extract<RemotePush, { type: "preview" }>[] = [];
  readonly ended: string[] = [];
  push(push: RemotePush) {
    if (push.type === "preview") this.pushes.push(push);
    if (push.type === "preview.ended") this.ended.push(push.message);
  }
  get frames() {
    return this.pushes.flatMap((push) => (push.state.open && push.state.frame ? [push.state.frame.seq] : []));
  }
  get last() {
    return this.pushes.at(-1)?.state;
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
/** The phone fetches every frame it is told of, as soon as it hears of it. */
function fetchEach(phone: FakePhone, threadId = "t1") {
  let seen = 0;
  return () => {
    for (const seq of phone.frames.slice(seen)) casters.frame(phone, threadId, seq);
    seen = phone.frames.length;
  };
}
async function run(ms: number, each?: () => void) {
  for (let left = ms; left > 0; left -= 50) {
    await vi.advanceTimersByTimeAsync(50);
    each?.();
  }
}

describe("a thread's caster", () => {
  it("answers the watch with the page shaped for a phone, and starts capturing", async () => {
    const phone = new FakePhone();
    expect(await casters.watch(phone, lan)).toEqual({
      open: true,
      pane: "0123456789ab",
      address: "http://127.0.0.1:47831/tick?code=[redacted:query]",
      title: "QA Tick",
      phase: "live",
      error: null,
      frame: null,
    });
    await run(100);
    expect(mac.captures).toHaveLength(1);
    expect(mac.captures[0]!.options).toEqual({ width: 786, quality: 60, unless: null });
    expect(phone.last).toMatchObject({ open: true, frame: { seq: 1, width: 786, height: 1038 } });
  });

  it("paces a painting page at 2 frames a second on LAN, never two under 450 ms apart", async () => {
    const phone = new FakePhone();
    await casters.watch(phone, lan);
    await run(10_000, fetchEach(phone));
    expect(phone.frames.length).toBeGreaterThanOrEqual(19);
    expect(phone.frames.length).toBeLessThanOrEqual(21);
    const gaps = mac.captures.slice(1).map((capture, i) => capture.at - mac.captures[i]!.at);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(450);
  });

  it("paces a tailnet route at 1 a second, narrower and at a lower quality", async () => {
    const phone = new FakePhone();
    await casters.watch(phone, { threadId: "t1", width: 1600, pace: "tailnet" });
    await run(10_000, fetchEach(phone));
    expect(phone.frames.length).toBeGreaterThanOrEqual(9);
    expect(phone.frames.length).toBeLessThanOrEqual(11);
    expect(mac.captures[0]!.options).toMatchObject({ width: 1200, quality: 50 });
  });

  it("captures nothing more while the phone has not fetched the frame it was told of", async () => {
    const phone = new FakePhone();
    await casters.watch(phone, lan);
    await run(300);
    expect(phone.frames).toEqual([1]);
    const before = mac.captures.length;
    await run(1_000);
    expect(mac.captures).toHaveLength(before);
    expect(casters.frame(phone, "t1", 1)).toEqual(new Uint8Array([1]));
    await run(600);
    expect(mac.captures.length).toBe(before + 1);
  });

  it("never announces an unchanged page, and slows to one capture every 2 s until a pane event", async () => {
    const phone = new FakePhone();
    await casters.watch(phone, lan);
    const each = fetchEach(phone);
    await run(300, each);
    mac.painting = false;
    const start = mac.captures.length;
    await run(10_000, each);
    const idle = mac.captures.slice(start);
    expect(phone.frames).toEqual([1]);
    const gaps = idle.slice(1).map((capture, i) => capture.at - idle[i]!.at);
    expect(gaps.slice(0, 3)).toEqual([1000, 2000, 2000]);
    expect(idle.length).toBeLessThanOrEqual(7);
    mac.change("t1", false);
    mac.painting = true;
    const reset = mac.captures.length;
    await run(1_200, each);
    expect(mac.captures.length - reset).toBeGreaterThanOrEqual(2);
  });

  it("pushes the page's state on a pane event, coalesced to one per 250 ms, and the closed state when the page goes", async () => {
    const phone = new FakePhone();
    await casters.watch(phone, lan);
    await run(100, fetchEach(phone));
    phone.pushes.length = 0;
    mac.page = { ...mac.page!, loading: true, title: "Loading ghp_x" };
    mac.change("t1", false);
    mac.change("t1", false);
    mac.change("t1", true);
    await run(300);
    const states = phone.pushes.filter((push) => push.state.open && push.state.phase === "loading");
    expect(states).toHaveLength(1);
    expect(states[0]!.state).toMatchObject({ title: "Loading [token]x", frame: { seq: 1 } });
    mac.page = null;
    mac.change("t1", true);
    await run(300);
    expect(phone.last).toEqual({ open: false });
    expect(casters.frame(phone, "t1", 1)).toBeNull();
    const parked = mac.captures.length;
    await run(5_000);
    expect(mac.captures.length).toBeLessThanOrEqual(parked + 1);
  });

  it("keeps the frame it holds when a capture comes back empty while the page is still open", async () => {
    const phone = new FakePhone();
    await casters.watch(phone, lan);
    await run(100, fetchEach(phone));
    const capture = vi.spyOn(mac, "capture").mockResolvedValueOnce(null);
    await run(600, fetchEach(phone));
    expect(capture).toHaveBeenCalled();
    expect(phone.pushes.some((push) => !push.state.open)).toBe(false);
    expect(casters.frame(phone, "t1", phone.frames.at(-1)!)).not.toBeNull();
  });
});

describe("a frame held back for pacing", () => {
  it("is announced once the phone's slot opens, so a page that stops changing ends on its last frame", async () => {
    // A slow first capture (the debugger attaching), then a quick one, then nothing changes.
    mac.latencies = [300];
    mac.paints = 2;
    const phone = new FakePhone();
    await casters.watch(phone, lan);
    await run(5_000, fetchEach(phone));
    expect(phone.frames).toEqual([1, 2]);
  });

  it("reaches a tailnet phone beside a LAN one, which the LAN pace would otherwise leave a frame behind", async () => {
    mac.paints = 2;
    const fast = new FakePhone();
    const lean = new FakePhone();
    await casters.watch(fast, lan);
    await casters.watch(lean, { ...lan, pace: "tailnet" });
    const fetchFast = fetchEach(fast);
    const fetchLean = fetchEach(lean);
    await run(5_000, () => {
      fetchFast();
      fetchLean();
    });
    expect(fast.frames).toEqual([1, 2]);
    expect(lean.frames).toEqual([1, 2]);
  });

  it("is not announced again to a phone that fetched it from a state push, which keeps its credit", async () => {
    mac.paints = 2;
    const fast = new FakePhone();
    const lean = new FakePhone();
    await casters.watch(fast, lan);
    await casters.watch(lean, { ...lan, pace: "tailnet" });
    const fetchFast = fetchEach(fast);
    await run(100, () => {
      fetchFast();
      for (const seq of lean.frames) casters.frame(lean, "t1", seq);
    });
    // The second frame lands inside the tailnet phone's slot; a pane event names it to both before the slot opens.
    await run(500, fetchFast);
    expect(lean.frames).toEqual([1]);
    mac.change("t1", false);
    await run(300, fetchFast);
    expect(lean.frames).toEqual([1, 2]);
    casters.frame(lean, "t1", 2);
    mac.paints = Infinity;
    mac.change("t1", false);
    await run(2_000, () => {
      fetchFast();
      for (const seq of lean.frames.slice(2)) casters.frame(lean, "t1", seq);
    });
    expect(lean.frames.filter((seq) => seq === 2)).toHaveLength(1);
    expect(lean.frames.at(-1)).toBeGreaterThan(2);
  });
});

describe("watchers", () => {
  it("lets a second phone join with the newest frame, and both hear the next one", async () => {
    const first = new FakePhone();
    await casters.watch(first, lan);
    await run(100, fetchEach(first));
    const second = new FakePhone();
    expect(await casters.watch(second, lan)).toMatchObject({ frame: { seq: 1 } });
    expect(casters.frame(second, "t1", 1)).toEqual(new Uint8Array([1]));
    await run(600, () => {
      fetchEach(first)();
      fetchEach(second)();
    });
    expect(first.frames).toContain(2);
    expect(second.frames).toContain(2);
    expect(mac.query).toHaveBeenCalledTimes(1);
  });

  it("serves a frame only to a session watching that thread, and no newer than the newest", async () => {
    const phone = new FakePhone();
    const stranger = new FakePhone();
    await casters.watch(phone, lan);
    await run(100);
    expect(casters.frame(stranger, "t1", 1)).toBeNull();
    expect(casters.frame(phone, "t2", 1)).toBeNull();
    expect(casters.frame(phone, "t1", 2)).toBeNull();
    expect(casters.frame(phone, "t1", 0)).toBeNull();
  });

  it("ends a deleted thread's watches: every watcher hears why, and no capture or frame follows", async () => {
    const first = new FakePhone();
    const second = new FakePhone();
    const elsewhere = new FakePhone();
    await casters.watch(first, lan);
    await casters.watch(second, lan);
    await casters.watch(elsewhere, { ...lan, threadId: "t2" });
    await run(100);
    casters.end("t1", "This thread is gone.");
    expect([first.ended, second.ended, elsewhere.ended]).toEqual([["This thread is gone."], ["This thread is gone."], []]);
    expect(casters.frame(first, "t1", 1)).toBeNull();
    const t1 = mac.captures.filter((capture) => capture.threadId === "t1").length;
    await run(3_000, fetchEach(elsewhere, "t2"));
    expect(mac.captures.filter((capture) => capture.threadId === "t1")).toHaveLength(t1);
    expect(elsewhere.frames.length).toBeGreaterThan(1);
  });

  it("replaces a session's earlier watch, and ends a caster and its frame with its last watcher", async () => {
    const phone = new FakePhone();
    await casters.watch(phone, lan);
    await run(100);
    await casters.watch(phone, { ...lan, threadId: "t2" });
    expect(casters.frame(phone, "t1", 1)).toBeNull();
    await run(300);
    const t1 = mac.captures.filter((capture) => capture.threadId === "t1").length;
    casters.unwatch(phone);
    const total = mac.captures.length;
    await run(5_000);
    expect(mac.captures.filter((capture) => capture.threadId === "t1")).toHaveLength(t1);
    expect(mac.captures).toHaveLength(total);
    expect(casters.frame(phone, "t2", 1)).toBeNull();
  });
});
