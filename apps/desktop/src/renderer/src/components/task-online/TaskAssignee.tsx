import { useState } from "react";
import { Menu } from "@base-ui/react/menu";
import type { OnlineTaskAssignee } from "@openorc/protocol";
import { useTaskRoster } from "../../lib/task-roster";
import type { TaskOnlineScope } from "../../lib/task-online-query";
import { CoversPreview } from "../../lib/browser-preview";
import { floatingGround } from "../../lib/use-anchor-ground";
import { cn } from "../../lib/cn";
import { AccountFace } from "../AccountFace";
import { Check, ChevronDown, CircleUser } from "../icons";
import { menuItem, menuPopup, menuSeparator } from "../menu";
import { Button, Input } from "../ui";
import "./tasks.css";

export function TaskAssignee({
  scope,
  projectId,
  value,
  disabled,
  onChange,
}: {
  scope: TaskOnlineScope;
  projectId: string;
  value: OnlineTaskAssignee | null;
  disabled?: boolean;
  onChange(person: OnlineTaskAssignee | null): void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const roster = useTaskRoster(scope, projectId, open && !disabled, search);
  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger className="property-chip min-w-0 max-w-64" disabled={disabled} aria-label={`Assignee: ${value?.name ?? "Unassigned"}`}>
        {value ? <AccountFace name={value.name} image={value.image} className="task-assignee-face" /> : <CircleUser size={14} />}
        <span className="truncate" data-tip={value?.name}>
          {value?.name ?? "Unassigned"}
        </span>
        <ChevronDown size={12} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={6} align="start" className="z-40" collisionPadding={8}>
          <Menu.Popup ref={floatingGround} className={cn(menuPopup, "min-w-52")}>
            {roster.people.length > 8 || roster.hasNextPage || search ? (
              <div className="px-2 py-1">
                <Input aria-label="Find a person" placeholder="Find a person" value={search} onChange={(event) => setSearch(event.target.value)} />
              </div>
            ) : null}
            <Menu.Item className={menuItem} onClick={() => onChange(null)}>
              <CircleUser size={14} />
              <span className="flex-1">Unassigned</span>
              {value === null ? <Check size={13} /> : null}
            </Menu.Item>
            <Menu.Separator className={menuSeparator} />
            {roster.people.map((person) => (
              <Menu.Item
                key={person.memberId}
                className={menuItem}
                disabled={!person.available}
                data-tip={!person.available ? "This person can’t use the project right now." : undefined}
                onClick={() => onChange(person)}
              >
                <AccountFace name={person.name} image={person.image} className="task-assignee-face" />
                <span className="min-w-0 flex-1 truncate" data-tip={person.name}>
                  {person.name}
                </span>
                {person.memberId === value?.memberId ? <Check size={13} /> : null}
              </Menu.Item>
            ))}
            {roster.isLoading ? <p className="px-3 py-2 text-sm text-ink-3">Loading people…</p> : null}
            {roster.error ? (
              <div className="px-3 py-2 text-sm text-bad" role="alert">
                People couldn’t load.{" "}
                <Button size="sm" onClick={() => void roster.refetch()}>
                  Try again
                </Button>
              </div>
            ) : null}
            {roster.hasNextPage ? (
              <Menu.Item className={menuItem} disabled={roster.isFetchingNextPage} onClick={() => void roster.fetchNextPage()} closeOnClick={false}>
                More people
              </Menu.Item>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
