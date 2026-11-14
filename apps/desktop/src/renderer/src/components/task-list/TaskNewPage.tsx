import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { useRouter } from "../../lib/router";
import { Check, Plus } from "../icons";
import { PageCrumbs } from "../PageTitle";
import { TopBar } from "../TopBar";
import { Button } from "../ui";

export function TaskNewPage({
  draftStored,
  gate,
  submit,
  children,
  footer,
  disabled,
  pending,
}: {
  draftStored: boolean;
  gate: ReactNode;
  submit(): void;
  children: ReactNode;
  footer?: ReactNode;
  disabled: boolean;
  pending: boolean;
}) {
  return (
    <div className="task-workspace h-full flex flex-col min-h-0">
      <TopBar
        actions={
          <span className={cn("text-sm inline-flex items-center gap-1.5", draftStored ? "text-ink-4" : "text-bad")} role="status">
            {draftStored ? (
              <>
                <Check size={12} />
                Draft saved locally
              </>
            ) : (
              "Local draft couldn’t be saved. Keep this page open."
            )}
          </span>
        }
      >
        <PageCrumbs parent="Tasks" onParent={() => useRouter.getState().navigate({ view: "tasks" })}>
          <span className="truncate">New task</span>
        </PageCrumbs>
      </TopBar>
      {gate ?? (
        <form
          className="flex-1 min-h-0 flex flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        >
          <div className="task-scroll">
            <div className="task-document">{children}</div>
          </div>
          <footer className="document-footer">
            <div className="min-w-0">
              <p className="text-sm text-ink-3">Saves to backlog. Continue in a thread when you’re ready.</p>
              {footer}
            </div>
            <Button type="submit" variant="primary" size="lg" disabled={disabled}>
              <Plus size={14} />
              {pending ? "Creating…" : "Create task"}
            </Button>
          </footer>
        </form>
      )}
    </div>
  );
}
