import { describe, expect, it, vi } from "vitest";
import { NotificationDelivery, NotificationVisibility, noticeDestination, noticeVisible, type DesktopNotice, type NotificationPlatform, type VisibilityChannel } from "./notification-delivery";

const notice: DesktopNotice = { type: "notify", id: "approval:run:request", kind: "approval", threadId: "thread", taskId: "worker", title: "Team", body: "Engineer needs approval" };
function platform() {
  let receipts: unknown = [];
  let lock: Promise<unknown> = Promise.resolve();
  const value: NotificationPlatform = {
    exclusive: (operation) => {
      const next = lock.then(operation);
      lock = next.catch(() => undefined);
      return next;
    },
    readReceipts: () => receipts,
    writeReceipts: (next) => {
      receipts = next;
    },
    now: () => 100_000,
    visible: vi.fn(async () => false),
    settings: vi.fn(async () => ({ notifications: true, sound: true })),
    permission: vi.fn(async () => true),
    show: vi.fn(),
  };
  return value;
}
describe("desktop notification delivery", () => {
  it("recognizes focused root, split, and exact worker; worker clicks open that task", () => {
    expect(noticeVisible(notice, { focused: true, threadIds: ["thread"], taskId: null })).toBe(true);
    expect(noticeVisible(notice, { focused: true, threadIds: ["other", "thread"], taskId: null })).toBe(true);
    expect(noticeVisible(notice, { focused: true, threadIds: [], taskId: "worker" })).toBe(true);
    expect(noticeVisible(notice, { focused: false, threadIds: ["thread"], taskId: "worker" })).toBe(false);
    expect(noticeVisible(notice, { focused: true, threadIds: ["other"], taskId: "other" })).toBe(false);
    expect(noticeDestination(notice)).toEqual({ view: "task", taskId: "worker", tab: "chat" });
    expect(noticeDestination({ threadId: "thread", taskId: null })).toEqual({ view: "thread", threadId: "thread" });
  });
  it("never catches up alerts suppressed by focus or preferences", async () => {
    const p = platform();
    vi.mocked(p.visible).mockResolvedValueOnce(true);
    const delivery = new NotificationDelivery(p);
    await delivery.receive(notice);
    await delivery.receive(notice);
    expect(p.show).not.toHaveBeenCalled();
    vi.mocked(p.settings).mockResolvedValueOnce({ notifications: false, sound: true });
    await delivery.receive({ ...notice, id: "disabled" });
    await delivery.receive({ ...notice, id: "disabled" });
    expect(p.show).not.toHaveBeenCalled();
  });
  it("rechecks focus and preferences after asynchronous permission or settings changes", async () => {
    const p = platform();
    vi.mocked(p.visible).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await new NotificationDelivery(p).receive(notice);
    expect(p.permission).toHaveBeenCalled();
    expect(p.show).not.toHaveBeenCalled();
    vi.mocked(p.visible).mockResolvedValue(false);
    vi.mocked(p.settings).mockResolvedValueOnce({ notifications: true, sound: true }).mockResolvedValueOnce({ notifications: false, sound: false });
    await new NotificationDelivery(p).receive({ ...notice, id: "changed-preference" });
    expect(p.show).not.toHaveBeenCalled();
  });
  it("does not play sound or show after permission/storage failure and bounds retained identities", async () => {
    const p = platform();
    vi.mocked(p.permission).mockResolvedValueOnce(false);
    await new NotificationDelivery(p).receive(notice);
    expect(p.show).not.toHaveBeenCalled();
    p.writeReceipts(Array.from({ length: 1100 }, (_, i) => ({ id: String(i), at: p.now() })));
    await new NotificationDelivery(p).receive({ ...notice, id: "latest" });
    expect(p.readReceipts()).toHaveLength(1000);
    p.writeReceipts = () => {
      throw Error("storage denied");
    };
    await expect(new NotificationDelivery(p).receive({ ...notice, id: "unclaimed" })).rejects.toThrow("storage denied");
    expect(p.show).toHaveBeenCalledTimes(1);
  });
  it("suppresses duplicate dispatch after a showing failure and refuses missing delivery identity", async () => {
    const p = platform();
    vi.mocked(p.show).mockImplementationOnce(() => {
      throw Error("OS unavailable");
    });
    const delivery = new NotificationDelivery(p);
    await expect(delivery.receive(notice)).rejects.toThrow("OS unavailable");
    await delivery.receive(notice);
    await delivery.receive({ ...notice, id: undefined });
    expect(p.show).toHaveBeenCalledTimes(1);
  });
});

describe("cross-window visibility", () => {
  function channels() {
    const peers = new Set<(event: MessageEvent) => void>();
    const make = (): VisibilityChannel => {
      let listener: ((event: MessageEvent) => void) | null = null;
      return {
        postMessage(data) {
          for (const peer of peers) if (peer !== listener) queueMicrotask(() => peer({ data } as MessageEvent));
        },
        addEventListener(_type, next) {
          listener = next;
          peers.add(next);
        },
        removeEventListener(_type, previous) {
          peers.delete(previous);
        },
      };
    };
    return make;
  }
  it("suppresses an unfocused receiver when another window shows the target", async () => {
    const make = channels();
    let seq = 0;
    const first = new NotificationVisibility(
      make(),
      () => false,
      () => `a-${seq++}`,
      2,
    );
    const second = new NotificationVisibility(
      make(),
      (target) => target.taskId === "worker",
      () => `b-${seq++}`,
      2,
    );
    expect(await first.check(notice)).toBe(true);
    second.close();
    expect(await first.check(notice)).toBe(false);
    first.close();
  });
  it("rechecks local focus after waiting and treats teardown as suppressed", async () => {
    const make = channels();
    let local = false;
    const peer = new NotificationVisibility(
      make(),
      () => local,
      () => "probe",
      2,
    );
    const waiting = peer.check(notice);
    local = true;
    expect(await waiting).toBe(true);
    local = false;
    const closing = peer.check(notice);
    peer.close();
    expect(await closing).toBe(true);
  });
});
