import { useMemo } from "react";
import type { Orcling, OrclingGroup, ThreadSummary } from "@openorc/protocol";
import type { MentionEntry } from "./composer-mentions";
import type { Route } from "./router";
import { useRpc } from "./client";

const NONE: Orcling[] = [];
const NO_GROUPS: OrclingGroup[] = [];

/** Every Orcling, oldest first. */
export function useOrclings(): Orcling[] {
  return useRpc("orclings.list", {}).data ?? NONE;
}

/** Every group chat of Orclings, oldest first. */
export function useOrclingGroups(): OrclingGroup[] {
  return useRpc("orclings.groups.list", {}).data ?? NO_GROUPS;
}

/** Conversations that belong to Orclings, never listed among project threads: their own chats and their group chats. */
export function useOrclingChatIds(): ReadonlySet<string> {
  const orclings = useOrclings();
  const groups = useOrclingGroups();
  return useMemo(() => new Set([...orclings.map((orcling) => orcling.threadId), ...groups.map((group) => group.threadId)]), [orclings, groups]);
}

export function orclingById(orclings: readonly Orcling[], id: string | null | undefined): Orcling | null {
  return id ? (orclings.find((orcling) => orcling.id === id) ?? null) : null;
}

/** The Orcling whose own conversation this is. */
export function orclingHome(orclings: readonly Orcling[], threadId: string | null | undefined): Orcling | null {
  return threadId ? (orclings.find((orcling) => orcling.threadId === threadId) ?? null) : null;
}

/** Orclings a message can ask with `@`, leaving out the one already working in the conversation. */
export function orclingMentionEntries(orclings: readonly Orcling[], except: string | null | undefined): MentionEntry[] {
  return orclings.filter((orcling) => orcling.id !== except).map((orcling) => ({ key: `orcling:${orcling.id}`, name: orcling.name, hint: "Orcling" }));
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The Orcling a message asks for by name; names can have several words, so the longest match wins. */
export function mentionedOrcling(text: string, orclings: readonly Orcling[]): Orcling | null {
  if (!orclings.length) return null;
  const names = [...orclings].sort((a, b) => b.name.length - a.name.length);
  const pattern = new RegExp(`(?:^|[^\\w@])@(${names.map((orcling) => escape(orcling.name)).join("|")})(?![\\w-])`, "iu");
  const match = pattern.exec(text);
  return match ? (names.find((orcling) => orcling.name.toLowerCase() === match[1]!.toLowerCase()) ?? null) : null;
}

/** Where to land once an Orcling is deleted: the chat beside it in the list, below it or else above, or a new Orcling when it was the last. */
export function afterOrclingDeleted(orclings: readonly Orcling[], id: string): Route {
  const at = orclings.findIndex((orcling) => orcling.id === id);
  const beside = orclings[at + 1] ?? orclings[at - 1];
  return beside ? { view: "thread", threadId: beside.threadId } : { view: "orcling" };
}

/** The group chats deleting an Orcling takes with it, those left with one other Orcling, named by that one. */
export function groupsGoingWith(groups: readonly OrclingGroup[], orclings: readonly Orcling[], id: string): string[] {
  const going = groups.filter((group) => group.memberIds.includes(id) && group.memberIds.length <= 2);
  return [...new Set(going.flatMap((group) => group.memberIds.filter((member) => member !== id).map((member) => orclingById(orclings, member)?.name ?? "")))].filter(Boolean);
}

/**
 * Where to land once a chat in the Orclings list is deleted, an Orcling's own or a group's: the chat beside it in the
 * list as the sidebar shows it, below it or else above, or a new Orcling when none is left.
 */
export function afterOrclingChatDeleted(orclings: readonly Orcling[], groups: readonly OrclingGroup[], threadId: string): Route {
  const chats = [...orclings.map((orcling) => orcling.threadId), ...groups.map((group) => group.threadId)];
  const at = chats.indexOf(threadId);
  const beside = at < 0 ? undefined : (chats[at + 1] ?? chats[at - 1]);
  return beside ? { view: "thread", threadId: beside } : { view: "orcling" };
}

type ChatState = Pick<ThreadSummary, "unread" | "lastActivityAt" | "seenAt">;

/**
 * The Orcling the window's header shows: the one whose unread message is newest, else the one whose chat the person
 * looked at last, else the first. One whose chat is already on screen is left out. `chats` follows `orclings`.
 */
export function headerOrcling(orclings: readonly Orcling[], chats: readonly (ChatState | null | undefined)[], shown: readonly string[]): Orcling | null {
  const candidates = orclings.flatMap((orcling, index) => (shown.includes(orcling.threadId) ? [] : [{ orcling, chat: chats[index] }]));
  const newest = (key: (chat: ChatState) => number | null) =>
    candidates.reduce<{ orcling: Orcling; at: number } | null>((best, { orcling, chat }) => {
      const at = chat ? key(chat) : null;
      return at !== null && (!best || at > best.at) ? { orcling, at } : best;
    }, null)?.orcling ?? null;
  return newest((chat) => (chat.unread ? chat.lastActivityAt : null)) ?? newest((chat) => chat.seenAt) ?? candidates[0]?.orcling ?? null;
}
