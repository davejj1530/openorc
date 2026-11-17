import { hostedReviewPending } from "@openorc/client";
import { HostedActionRequest, HostedReviewReply } from "@openorc/protocol";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { call, client, shownMacId, storage } from "../client";
import { failureMessage } from "../failure";

/** A commit, push or pull request asked of a cloud thread, and the server's last answer to it. */
type Kept = { request: HostedActionRequest; reply: HostedReviewReply | null };

const keyOf = (threadId: string) => `cloud-review.${shownMacId() ?? "none"}.${threadId}`;
const listeners = new Set<() => void>();
const kept = new Map<string, Kept | null>();

function read(threadId: string): Kept | null {
  const key = keyOf(threadId);
  if (kept.has(key)) return kept.get(key)!;
  let value: Kept | null = null;
  try {
    const saved: unknown = JSON.parse(storage.getString(key) ?? "null");
    if (saved && typeof saved === "object" && "request" in saved) {
      const request = HostedActionRequest.safeParse(saved.request);
      const reply = HostedReviewReply.safeParse("reply" in saved ? saved.reply : null);
      value = request.success ? { request: request.data, reply: reply.success ? reply.data : null } : null;
    }
  } catch {
    value = null;
  }
  kept.set(key, value);
  return value;
}

function write(threadId: string, value: Kept | null): void {
  const key = keyOf(threadId);
  if (value) storage.set(key, JSON.stringify(value));
  else storage.remove(key);
  kept.set(key, value);
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Starts a commit, push or pull request on a cloud thread: kept on the phone first, so a lost answer asks the same again. */
export function startCloudReview(threadId: string, request: HostedActionRequest): void {
  write(threadId, { request, reply: null });
}

/**
 * A cloud thread's commit, push or pull request as the desktop keeps one: the request is kept on the phone before it is
 * sent, and asked again, the same request, until the server says it is done, after a lost answer, the app coming back,
 * or Retry. `live`: the thread's server is in reach, so the request can go.
 */
export function useCloudReview(threadId: string, live: boolean) {
  const current = useSyncExternalStore(subscribe, () => read(threadId));
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const pending = Boolean(current && (!current.reply || (current.reply.accepted && hostedReviewPending(current.reply.action))));
  const request = current?.request;
  useEffect(() => {
    if (!pending) return;
    const watch = AppState.addEventListener("change", (state) => state === "active" && setAttempt((value) => value + 1));
    return () => watch.remove();
  }, [pending]);
  useEffect(() => {
    if (!live || !pending || !request) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      try {
        const reply = await call("hosted.review.action", { threadId, action: request });
        if (!active) return;
        write(threadId, { request, reply });
        setError(null);
        client.invalidateTags(["threads", `thread:${threadId}`, `threaddiff:${threadId}`], { immediate: true });
        if (reply.accepted && hostedReviewPending(reply.action)) timer = setTimeout(() => void ask(), 1500);
      } catch (failure) {
        if (active) setError(failureMessage(failure));
      }
    };
    void ask();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [threadId, live, pending, request, attempt]);
  return {
    request: current?.request ?? null,
    result: current?.reply?.accepted ? current.reply.action : null,
    refusal: current?.reply?.accepted === false ? current.reply.line : null,
    pending,
    error,
    retry: useCallback(() => {
      setError(null);
      setAttempt((value) => value + 1);
    }, []),
  };
}
