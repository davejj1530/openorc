import { useMemo } from "react";
import type { Orcling, OrclingGroup } from "@openorc/protocol";
import type { MentionEntry } from "./composer-mentions";
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
