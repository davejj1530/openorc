import type { PushEnvelope, PushNotice } from "@openorc/link";
import type { AlertPlan } from "./plan.js";

/** All Apple, and a phone that cannot open the alert, ever show, by the host that sent it. */
export const OUTER_TEXT = { mac: "New activity on your Mac", cloud: "New activity in the cloud" } as const;
export type AlertHost = keyof typeof OUTER_TEXT;
const TITLE_MAX = 120;
const BODY_MAX = 600;
const PAYLOAD_MAX_BYTES = 4096;

/** At most `max` code points, the last of them "…" when anything was cut. */
export function clip(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return max < 1 ? "" : `${points.slice(0, max - 1).join("")}…`;
}

function apnsJson(envelope: PushEnvelope, plan: AlertPlan, host: AlertHost): string {
  const aps = {
    alert: { body: OUTER_TEXT[host] },
    "mutable-content": 1,
    ...(plan.kind === "ring" && plan.sound ? { sound: "default" } : {}),
    ...(plan.kind === "quiet" ? { "interruption-level": "passive" } : {}),
  };
  return JSON.stringify({ aps, o: envelope });
}

/** The APNs JSON for a notice, its body halved until the whole thing fits Apple's limit. Null when even no body is too much. */
export function fitPayload(notice: PushNotice, plan: AlertPlan, seal: (notice: PushNotice) => PushEnvelope, host: AlertHost = "mac"): string | null {
  let fitted: PushNotice = { ...notice, title: clip(notice.title, TITLE_MAX), body: clip(notice.body, BODY_MAX) };
  for (;;) {
    const payload = apnsJson(seal(fitted), plan, host);
    if (Buffer.byteLength(payload) <= PAYLOAD_MAX_BYTES) return payload;
    const length = Array.from(fitted.body).length;
    if (length === 0) return null;
    fitted = { ...fitted, body: clip(fitted.body, Math.floor(length / 2)) };
  }
}
