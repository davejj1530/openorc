import type { CorePush } from "@openorc/protocol";

export type DesktopNotice = Extract<CorePush, { type: "notify" }>;
export interface NoticeTarget {
  threadId: string | null;
  taskId: string | null;
}
export interface NoticePresence {
  focused: boolean;
  threadIds: readonly string[];
  taskId: string | null;
}
export function noticeVisible(target: NoticeTarget, presence: NoticePresence): boolean {
  return presence.focused && Boolean((target.threadId && presence.threadIds.includes(target.threadId)) || (target.taskId && target.taskId === presence.taskId));
}
export function noticeDestination(notice: NoticeTarget): { view: "task"; taskId: string; tab: "chat" } | { view: "thread"; threadId: string } | null {
  if (notice.taskId) return { view: "task", taskId: notice.taskId, tab: "chat" };
  if (notice.threadId) return { view: "thread", threadId: notice.threadId };
  return null;
}

export interface NotificationPlatform {
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  readReceipts(): unknown;
  writeReceipts(value: { id: string; at: number }[]): void;
  now(): number;
  visible(target: NoticeTarget): Promise<boolean>;
  settings(): Promise<{ notifications: boolean; sound: boolean }>;
  permission(): Promise<boolean>;
  show(notice: DesktopNotice, sound: boolean): void;
}

/** A single cross-window lock covers receipt storage, visibility and the OS side effect. */
export class NotificationDelivery {
  constructor(private readonly platform: NotificationPlatform) {}

  async receive(notice: DesktopNotice): Promise<void> {
    // Older cores lack delivery identity. Do not guess an identity that merges
    // unrelated approvals or claim cross-window deduplication without one.
    if (!notice.id) return;
    await this.platform.exclusive(async () => {
      const value = this.platform.readReceipts();
      const cutoff = this.platform.now() - 7 * 24 * 60 * 60_000;
      const receipts = Array.isArray(value)
        ? value.filter((item): item is { id: string; at: number } => Boolean(item && typeof item.id === "string" && typeof item.at === "number" && item.at >= cutoff))
        : [];
      if (receipts.some((item) => item.id === notice.id)) return;
      // Persist before any async work: preference/focus suppression and failed
      // permission requests must never become delayed catch-up notifications.
      this.platform.writeReceipts([...receipts.slice(-999), { id: notice.id!, at: this.platform.now() }]);
      if (await this.platform.visible(notice)) return;
      const settings = await this.platform.settings();
      if (!settings.notifications || !(await this.platform.permission())) return;
      if (await this.platform.visible(notice)) return;
      // Preferences can change while the OS permission prompt is open.
      const latest = await this.platform.settings();
      if (!latest.notifications || (await this.platform.visible(notice))) return;
      this.platform.show(notice, latest.sound);
    });
  }
}

export interface VisibilityChannel {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

/** Focused peers answer promptly even when this receiving window is hidden. */
export class NotificationVisibility {
  private readonly waiting = new Map<string, (visible: boolean) => void>();
  private readonly listener = (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data.id !== "string") return;
    if (data.type === "query" && isTarget(data.target)) {
      if (this.local(data.target)) this.channel.postMessage({ type: "visible", id: data.id });
    } else if (data.type === "visible") this.waiting.get(data.id)?.(true);
  };
  constructor(
    private readonly channel: VisibilityChannel,
    private readonly local: (target: NoticeTarget) => boolean,
    private readonly id: () => string,
    private readonly delayMs = 120,
  ) {
    channel.addEventListener("message", this.listener);
  }
  async check(target: NoticeTarget): Promise<boolean> {
    if (this.local(target)) return true;
    const id = this.id();
    const peer = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(false);
      }, this.delayMs);
      this.waiting.set(id, (visible) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(visible);
      });
      this.channel.postMessage({ type: "query", id, target });
    });
    return peer || this.local(target);
  }
  close(): void {
    this.channel.removeEventListener("message", this.listener);
    for (const resolve of this.waiting.values()) resolve(true);
    this.waiting.clear();
  }
}
function isTarget(value: unknown): value is NoticeTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as NoticeTarget;
  return (target.threadId === null || typeof target.threadId === "string") && (target.taskId === null || typeof target.taskId === "string");
}
