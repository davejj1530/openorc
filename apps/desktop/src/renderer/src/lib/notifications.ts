import { core } from "./rpc";
import { openThread, useRouter } from "./router";
import { NotificationDelivery, NotificationVisibility, noticeDestination, noticeVisible, type NoticeTarget } from "./notification-delivery";

/**
 * Notifications reach the OS only when the user is not already looking at
 * the thread: the window is unfocused, or another screen is open. Clicking
 * one opens the thread. Sound is a short tone from the audio context, so no
 * asset ships for it.
 */
export function installNotifications(): void {
  // Fail closed if this runtime cannot coordinate windows. Electron's secure
  // renderer supports both APIs; an unsafe per-window fallback duplicates alerts.
  if (!navigator.locks || typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel("openorc.notification.visibility.v1");
  const visibility = new NotificationVisibility(channel, onScreen, () => crypto.randomUUID());
  const key = "openorc.notification.receipts.v1";
  const delivery = new NotificationDelivery({
    exclusive: async (operation) => await navigator.locks.request("openorc.notification.delivery.v1", operation),
    readReceipts: () => JSON.parse(localStorage.getItem(key) ?? "[]") as unknown,
    writeReceipts: (receipts) => localStorage.setItem(key, JSON.stringify(receipts)),
    now: () => Date.now(),
    visible: (target) => visibility.check(target),
    settings: () => bounded(core.call("app.settings.get", {})),
    permission: async () => {
      if (typeof Notification === "undefined") return false;
      if (Notification.permission === "default") await bounded(Notification.requestPermission());
      return Notification.permission === "granted";
    },
    show: (n, sound) => {
      const note = new Notification(n.title, { body: n.body, silent: true, tag: n.id });
      if (sound) tone();
      note.onclick = () => {
        window.focus();
        const route = noticeDestination(n);
        if (route?.view === "thread") openThread(route.threadId);
        else if (route) useRouter.getState().navigate(route);
      };
    },
  });
  const unsubscribe = core.onNotify((n) => {
    void delivery.receive(n).catch(() => undefined);
  });
  window.addEventListener(
    "pagehide",
    () => {
      unsubscribe();
      visibility.close();
      channel.close();
    },
    { once: true },
  );
}

function onScreen(n: NoticeTarget): boolean {
  const route = useRouter.getState().route;
  return noticeVisible(n, {
    focused: document.hasFocus(),
    threadIds: useRouter.getState().threadIds,
    taskId: route.view === "task" ? route.taskId : null,
  });
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Notification delivery timed out")), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let audio: AudioContext | null = null;

/** Two soft notes, the way native apps chime. */
function tone(): void {
  try {
    audio ??= new AudioContext();
    const at = audio.currentTime;
    for (const [freq, start] of [
      [660, 0],
      [880, 0.12],
    ] as const) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, at + start);
      gain.gain.exponentialRampToValueAtTime(0.08, at + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + start + 0.25);
      osc.connect(gain).connect(audio.destination);
      osc.start(at + start);
      osc.stop(at + start + 0.3);
    }
  } catch {
    // no audio device; the visual notification is enough
  }
}
