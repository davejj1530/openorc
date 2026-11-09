import { router } from "expo-router";
import type { ComponentProps } from "react";
import type { Button } from "@expo/ui/swift-ui";
import { useShares } from "../connection/use-shares";
import type { HomeTab } from "./BottomBar";

type Symbol = NonNullable<ComponentProps<typeof Button>["systemImage"]>;

/** What Home's New does: one thing at once, or a menu of what can be started from the tab in front. */
export type NewAction = { kind: "press"; label: string; onPress: () => void } | { kind: "menu"; label: string; items: { label: string; icon: Symbol; onPress: () => void }[] };

/** The Mac's capability that lets a phone make an Orcling, and the screen that does it. */
const ORCLING_MAKING = "orcling-edits";

/**
 * New for the tab in front: a thread on Threads; on Orclings, a menu to make an Orcling or start a thread, where the
 * Mac lets a phone make one, else a thread; on Tasks, a new task.
 */
export function newAction(tab: HomeTab, { newThread, makesOrclings }: { newThread: () => void; makesOrclings: boolean }): NewAction {
  const thread: NewAction = { kind: "press", label: "New thread", onPress: newThread };
  if (tab === "tasks") return { kind: "press", label: "New task", onPress: () => router.push("/new-task") };
  if (tab !== "orclings" || !makesOrclings) return thread;
  return {
    kind: "menu",
    label: "New",
    items: [
      { label: "New Orcling", icon: "face.smiling", onPress: () => router.push("/orcling-new") },
      { label: "New Thread", icon: "square.and.pencil", onPress: newThread },
    ],
  };
}

export function useNewAction(tab: HomeTab, newThread: () => void): NewAction {
  return newAction(tab, { newThread, makesOrclings: useShares(ORCLING_MAKING) === true });
}
