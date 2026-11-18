import { NEEDS_YOU_PAGE, threadStatus } from "@openorc/client";
import { cn } from "../lib/cn";
import { useSpaceRpc } from "../lib/space-queries";
import { OpenOrcMark } from "./OpenOrcMark";

/** The mark over the New thread question: at rest, and the working cube with its moving light while any agent works. */
export function NewThreadMark() {
  const threads = useSpaceRpc("threads.list", { filter: "active", orderBy: "activity", includeChildren: false, needsYou: true, limit: NEEDS_YOU_PAGE }, { refetchInterval: 60_000 });
  const working = threads.data?.some((thread) => threadStatus(thread)?.kind === "running") ?? false;
  return <OpenOrcMark size={44} working={working} className={cn("new-thread-mark", working && "working-cube")} />;
}
