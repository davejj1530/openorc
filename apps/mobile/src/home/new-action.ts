import { router } from "expo-router";
import type { ComponentProps } from "react";
import type { Button } from "@expo/ui/swift-ui";
import { useShares } from "../connection/use-shares";
import { useProjectAdding } from "../spaces/add-projects";
import type { HomeTab } from "./BottomBar";

type Symbol = NonNullable<ComponentProps<typeof Button>["systemImage"]>;

/** What Home's New does: one thing at once, or a menu of what can be started from the tab in front. */
export type NewAction = { kind: "press"; label: string; onPress: () => void } | { kind: "menu"; label: string; items: { label: string; icon: Symbol; onPress: () => void }[] };

/** The Mac's capability that lets a phone make an Orcling, and the screen that does it. */
const ORCLING_MAKING = "orcling-edits";

/** What New may start: a thread and a task always; an Orcling where the Mac lets a phone make one; a project in the space (`addsTo`) the phone may add to. */
interface Starts {
  newThread: () => void;
  newTask: () => void;
  makesOrclings: boolean;
  addsTo: string | null;
}

/**
 * New for the tab in front: on Threads a thread, or a menu of a thread and a project where the phone may add
 * projects; on Orclings, a menu to make an Orcling or start a thread, where the Mac lets a phone make one, else a
 * thread; on Tasks, a new task.
 */
export function newAction(tab: HomeTab, { newThread, newTask, makesOrclings, addsTo }: Starts): NewAction {
  const thread: NewAction = { kind: "press", label: "New thread", onPress: newThread };
  const newThreadItem = { label: "New Thread", icon: "square.and.pencil", onPress: newThread } as const;
  if (tab === "tasks") return { kind: "press", label: "New task", onPress: newTask };
  if (tab === "orclings") {
    if (!makesOrclings) return thread;
    return { kind: "menu", label: "New", items: [{ label: "New Orcling", icon: "face.smiling", onPress: () => router.push("/orcling-new") }, newThreadItem] };
  }
  if (tab !== "threads" || !addsTo) return thread;
  return {
    kind: "menu",
    label: "New",
    items: [newThreadItem, { label: "Add Project", icon: "folder.badge.plus", onPress: () => router.push({ pathname: "/add-projects", params: { spaceId: addsTo } }) }],
  };
}

export function useNewAction(tab: HomeTab, starts: Pick<Starts, "newThread" | "newTask">): NewAction {
  return newAction(tab, { ...starts, makesOrclings: useShares(ORCLING_MAKING) === true, addsTo: useProjectAdding() });
}
