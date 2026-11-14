import type { OnlineTask } from "@openorc/protocol";
import { openThread, useRouter } from "../../lib/router";
import { spaceNavigation } from "../../lib/space-navigation";
import { ArrowUpRight, Cloud, Lock } from "../icons";
import { TextButton } from "../ui";

function TaskLink({ link, label, beforeOpen }: { link: OnlineTask["execution"]; label: string; beforeOpen(): Promise<boolean> }) {
  if (link.state === "none") return null;
  return (
    <div className="flex items-center gap-4 mt-5 text-sm text-ink-3">
      <span>{label}</span>
      {link.state === "readable" ? (
        <TextButton
          tone="muted"
          className="min-w-0 inline-flex items-center gap-1.5"
          onClick={() => {
            const route = useRouter.getState().route;
            const { current, key } = spaceNavigation.getState();
            void beforeOpen().then((ok) => {
              const now = spaceNavigation.getState();
              if (ok && route === useRouter.getState().route && now.current === current && now.key === key) openThread(link.threadId);
            });
          }}
        >
          <Cloud size={12} />
          <span className="truncate">{link.title}</span>
          <ArrowUpRight size={12} />
        </TextButton>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <Lock size={12} />
          {link.state === "private" ? "Private thread" : "Thread unavailable"}
        </span>
      )}
    </div>
  );
}
export function TaskLinks({ task, beforeOpen }: { task: OnlineTask; beforeOpen(): Promise<boolean> }) {
  return (
    <>
      <TaskLink link={task.execution} label="Thread" beforeOpen={beforeOpen} />
      <TaskLink link={task.createdIn} label="Created in" beforeOpen={beforeOpen} />
    </>
  );
}
