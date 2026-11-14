import { useEffect, useState } from "react";
import { HostedActionRequest, HostedReviewReply } from "@openorc/protocol";
import { hostedReviewPending } from "@openorc/client";
import { core } from "./rpc";
import { invalidateTags } from "./client";

type KeptAction = { request: HostedActionRequest; reply: HostedReviewReply | null };
export type HostedActionController = ReturnType<typeof useHostedReviewAction>;
const keyOf = (threadId: string, account: string) => `hosted-review:${account}:${threadId}`;

function read(threadId: string, account: string): KeptAction | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(keyOf(threadId, account)) ?? "null");
    if (!value || typeof value !== "object" || !("request" in value)) return null;
    const request = HostedActionRequest.safeParse(value.request);
    const reply = HostedReviewReply.safeParse("reply" in value ? value.reply : null);
    return request.success ? { request: request.data, reply: reply.success ? reply.data : null } : null;
  } catch {
    return null;
  }
}

/** Keep the request before posting it. Reconnect and a lost response replay the exact same action. */
export function useHostedReviewAction(threadId: string, live: boolean, account: string) {
  const [kept, setKept] = useState(() => read(threadId, account));
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const pending = Boolean(kept && (!kept.reply || (kept.reply.accepted && hostedReviewPending(kept.reply.action))));
  const request = kept?.request;
  useEffect(() => {
    if (!pending) return;
    const reconcile = () => setAttempt((value) => value + 1);
    window.addEventListener("focus", reconcile);
    return () => window.removeEventListener("focus", reconcile);
  }, [pending]);
  const save = (next: KeptAction | null) => {
    if (next) localStorage.setItem(keyOf(threadId, account), JSON.stringify(next));
    else localStorage.removeItem(keyOf(threadId, account));
    setKept(next);
  };
  useEffect(() => {
    if (!live || !pending || !request) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const reply = await core.call("hosted.review.action", { threadId, action: request });
        if (!active) return;
        const next = { request, reply };
        localStorage.setItem(keyOf(threadId, account), JSON.stringify(next));
        setKept(next);
        setError(null);
        invalidateTags(["threads", `thread:${threadId}`, `threaddiff:${threadId}`], { immediate: true });
        if (reply.accepted && hostedReviewPending(reply.action)) timer = setTimeout(() => void poll(), 1500);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [threadId, live, pending, request, attempt, account]);
  return {
    request: kept?.request ?? null,
    result: kept?.reply?.accepted ? kept.reply.action : null,
    refusal: kept?.reply?.accepted === false ? kept.reply.line : null,
    pending,
    error,
    start(request: HostedActionRequest) {
      try {
        save({ request, reply: null });
        setError(null);
      } catch {
        setError("This action couldn't be saved on this device. Try again.");
      }
    },
    retry() {
      setError(null);
      setAttempt((value) => value + 1);
    },
    clear() {
      save(null);
      setError(null);
    },
  };
}
