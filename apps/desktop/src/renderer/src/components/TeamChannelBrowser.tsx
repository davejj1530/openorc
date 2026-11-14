import { useState } from "react";
import type { TeamConversation } from "@openorc/protocol";
import { useOpenTeamChat } from "../lib/team-chat-open";
import { TeamConversationFace } from "./TeamChatFace";
import { Button, Dialog, Input } from "./ui";
import { ChevronRight } from "./icons";
import "../styles/team-chat-channels.css";

export function TeamChannelBrowser({ conversations, self, onClose }: { conversations: readonly TeamConversation[]; self: string; onClose(): void }) {
  const [filter, setFilter] = useState("");
  const action = useOpenTeamChat();
  const channels = conversations
    .filter((item) => item.kind === "channel" && (!item.private || item.joined) && item.name?.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  return (
    <Dialog
      className="team-channel-dialog"
      open
      title="Channels"
      width={460}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className="team-channel-form">
        <Input variant="sheet" aria-label="Find a channel" placeholder="Find a channel" value={filter} onChange={(event) => setFilter(event.target.value)} />
        <div className="team-channel-browser">
          {channels.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className="team-channel-browser-row"
              onClick={() => {
                void action.open({ kind: "conversation", id: conversation.id, title: conversation.name ?? "Channel", conversation }).then((opened) => {
                  if (opened) onClose();
                });
              }}
            >
              <TeamConversationFace conversation={conversation} self={self} />
              <span>{conversation.name}</span>
              <span className="team-channel-browser-state">{conversation.joined ? "Joined" : "Open"}</span>
              <ChevronRight size={14} />
            </button>
          ))}
          {!channels.length ? <p className="text-sm text-ink-3">No channels found</p> : null}
        </div>
        <div className="team-channel-actions">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Dialog>
  );
}
