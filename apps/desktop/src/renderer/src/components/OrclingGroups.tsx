import { useState } from "react";
import type { Orcling, OrclingGroup } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "../lib/client";
import { cn } from "../lib/cn";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { messagePreview } from "../lib/message-preview";
import { orclingById } from "../lib/orclings";
import { useRouter } from "../lib/router";
import { People } from "./icons";
import { OrclingAvatar } from "./OrclingAvatar";
import { OrclingFaces, memberNames } from "./OrclingFaces";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";
import { Button, Checkbox, Dialog, IconButton, Input, Tooltip } from "./ui";

const openChat = (threadId: string) => {
  useRouter.getState().navigate({ view: "thread", threadId });
  dismissCompactNavigation();
};

/** A group chat as the Orclings list shows it: its Orclings' faces, its name, and the last thing said there. */
export function OrclingGroupRow({ group, orclings, active }: { group: OrclingGroup; orclings: readonly Orcling[]; active: boolean }) {
  const thread = useRpc("threads.get", { id: group.threadId });
  const last = useRpc("threads.lastMessage", { id: group.threadId }).data;
  const members = group.memberIds.flatMap((id) => orclingById(orclings, id) ?? []);
  const attention = Boolean(thread.data?.unread || thread.data?.activity === "waiting");
  const preview = last ? messagePreview(last.text) : "";
  return (
    <button
      type="button"
      onClick={() => openChat(group.threadId)}
      aria-current={active ? "page" : undefined}
      data-tip={group.title}
      className={cn("orcling-contact no-drag min-w-0 text-ink-2", (active || attention) && "text-ink")}
    >
      <OrclingFaces members={members} size={20} max={2} className="orcling-contact-faces" />
      <span className="flex flex-1 min-w-0 flex-col text-left">
        <span className="flex min-w-0 items-center">
          <span className="flex-1 min-w-0 truncate">{group.title}</span>
          {thread.data ? <ThreadStatusIndicator thread={thread.data} className="ml-1.5" /> : null}
        </span>
        {preview ? <span className="truncate text-sm text-ink-4">{last?.role === "user" ? `You: ${preview}` : preview}</span> : null}
      </span>
    </button>
  );
}

/** Starts a group chat with Orclings you choose, named after them unless you name it. */
export function NewOrclingGroupButton({ orclings }: { orclings: readonly Orcling[] }) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const create = useRpcMutation("orclings.groups.create");
  const members = chosen.flatMap((id) => orclingById(orclings, id) ?? []);
  const toggle = (id: string, on: boolean) => setChosen((current) => (on ? [...current, id] : current.filter((other) => other !== id)));
  const close = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setChosen([]);
      setTitle("");
      create.reset();
    }
  };
  if (orclings.length < 2) return null;
  return (
    <>
      <Tooltip label="New group chat">
        <IconButton onClick={() => setOpen(true)} aria-label="New group chat" size="lg" className="no-drag">
          <People size={16} />
        </IconButton>
      </Tooltip>
      <Dialog open={open} onOpenChange={close} title="New group chat" width={400}>
        <div className="grid gap-3">
          <ul className="grid" aria-label="Orclings">
            {orclings.map((orcling) => (
              <li key={orcling.id}>
                <label className="orcling-group-choice">
                  <OrclingAvatar orcling={orcling} size={24} />
                  <span className="flex-1 min-w-0 truncate">{orcling.name}</span>
                  <Checkbox checked={chosen.includes(orcling.id)} onChange={(event) => toggle(orcling.id, event.target.checked)} aria-label={orcling.name} />
                </label>
              </li>
            ))}
          </ul>
          <Input aria-label="Name" placeholder={members.length >= 2 ? memberNames(members) : "Name"} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={60} />
          {create.error ? (
            <p role="alert" className="text-sm text-bad">
              {create.error.message}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button
              disabled={chosen.length < 2 || create.isPending}
              onClick={() =>
                create.mutate(
                  { memberIds: chosen, ...(title.trim() ? { title: title.trim() } : {}) },
                  {
                    onSuccess: (group) => {
                      close(false);
                      openChat(group.threadId);
                    },
                  },
                )
              }
            >
              Start chat
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
