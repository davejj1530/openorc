import { fromBase64Url, openPush, pushKeys, type LinkCrypto, type PushEnvelope, type PushNotice } from "@openorc/link";
import { pushGroups, type NotifyKind } from "@openorc/protocol";
import { DEFAULT_ACTION_IDENTIFIER } from "expo-notifications";
import { z } from "zod";
import { queueAnswer, type AlertAnswer } from "./answers";

/**
 * What the extension leaves in an opened alert's data for the app: ids, and the sealed notice they came from, never
 * its text. Anyone able to push to this phone can write ids; only the Mac can seal them.
 */
export interface NoticeRoute {
  macId: string;
  id: string;
  kind: NotifyKind | "test";
  threadId?: string;
  runId?: string;
  approvalId?: string;
  o?: PushEnvelope;
}
/** The text iOS showed, as expo-notifications gives it: null where it was empty. */
export interface Shown {
  title: string | null;
  subtitle: string | null;
  body: string | null;
}
export type NoticeTap = { route: NoticeRoute; answer: AlertAnswer | null; shown: Shown };

/** The one category with actions; the extension names it on approvals that carry both ids. */
export const APPROVAL_CATEGORY = "approval";
export const approvalActions = [
  { identifier: "allow", buttonTitle: "Allow", options: { opensAppToForeground: true } },
  { identifier: "deny", buttonTitle: "Deny", options: { opensAppToForeground: true } },
] as const;

const id = z.string().min(1).max(200);
const sealed = z.string().max(8192);
const noticeRoute = z.object({
  macId: id,
  id,
  kind: z.custom<NotifyKind | "test">((value) => value === "test" || (typeof value === "string" && Object.hasOwn(pushGroups, value))),
  threadId: id.optional(),
  runId: id.optional(),
  approvalId: id.optional(),
  // A sealed notice that does not parse only answers nothing; the tap still opens its thread.
  o: z.object({ v: z.number(), m: sealed, n: sealed, c: sealed }).optional().catch(undefined),
});

/** The route in an alert's data, or null for an alert the extension could not open. */
export function routeOf(data: unknown): NoticeRoute | null {
  const parsed = noticeRoute.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** What a response to an alert asks for: open it, or answer its approval too. Null for a dismissal or a foreign alert. */
export function tapOf(actionIdentifier: string, content: Shown & { data?: unknown }): NoticeTap | null {
  const route = routeOf(content.data);
  if (!route) return null;
  if (actionIdentifier !== DEFAULT_ACTION_IDENTIFIER && actionIdentifier !== "allow" && actionIdentifier !== "deny") return null;
  const answers = actionIdentifier !== DEFAULT_ACTION_IDENTIFIER && route.kind === "approval" && route.runId && route.approvalId;
  return { route, answer: answers ? actionIdentifier : null, shown: { title: content.title, subtitle: content.subtitle, body: content.body } };
}

/** Opens a notice sealed by that Mac with this phone's key for it. Null when anything does not open. */
export function noticeOpener(crypto: LinkCrypto, readKey: (macId: string) => Promise<Uint8Array | null>) {
  return async (macId: string, envelope: PushEnvelope): Promise<PushNotice | null> => {
    try {
      const privateKey = await readKey(macId);
      if (!privateKey) return null;
      return openPush(crypto, pushKeys(crypto, crypto.keyPairFromPrivate(privateKey), fromBase64Url(macId), "phone").seal, envelope);
    } catch {
      return null;
    }
  };
}

export interface TapEffects {
  macs(): readonly { id: string }[];
  select(macId: string): void;
  openThread(threadId: string): void;
  open(macId: string, envelope: PushEnvelope): Promise<PushNotice | null>;
  now(): number;
}

/** Whether iOS showed the notice's own text, as the extension sets it, and not text pushed beside a recorded notice. */
const showed = (notice: PushNotice, shown: Shown) => (shown.title ?? "") === notice.title && !shown.subtitle && (shown.body ?? "") === notice.body;

/**
 * Shows the Mac that sent the alert, then its thread. An answer chosen on the alert waits for the approval's card only
 * when this phone's key opens the notice and iOS showed its text, so it is always for the approval the person read. An
 * alert from a Mac this phone forgot stays on Home.
 */
export async function openTap({ route, answer, shown }: NoticeTap, effects: TapEffects): Promise<void> {
  if (!effects.macs().some((mac) => mac.id === route.macId)) return;
  effects.select(route.macId);
  if (route.threadId) effects.openThread(route.threadId);
  if (!answer || !route.o) return;
  const notice = await effects.open(route.macId, route.o);
  if (notice?.kind === "approval" && notice.approval && showed(notice, shown)) queueAnswer({ macId: route.macId, ...notice.approval }, answer, effects.now());
}
