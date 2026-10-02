import type { Orcling } from "@openorc/protocol";
import type { MentionEntry } from "./composer-mentions";
import { useRpc } from "./query";

const NONE: Orcling[] = [];

/** Every Orcling, oldest first. */
export function useOrclings(): Orcling[] {
  return useRpc("orclings.list", {}).data ?? NONE;
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
