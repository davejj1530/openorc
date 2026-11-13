import { useMemo, type ReactNode } from "react";
import { WORKSPACE_ID, type Orcling, type Run, type ThreadSummary } from "@openorc/protocol";
import type { OutgoingMessage } from "@openorc/client";
import type { MentionEntry } from "../lib/composer-mentions";
import { mentionedOrcling, orclingById, orclingHome, orclingMentionEntries, useOrclingGroups, useOrclings } from "../lib/orclings";
import type { ConversationVoice, OrclingChatSpec } from "../lib/turn-authors";
import { OrclingFaces, OrclingGathering, memberNames } from "./OrclingFaces";
import { OrclingPreview } from "./OrclingPreview";
import { Empty } from "./ui";
import { useRpcMutation } from "../lib/client";
import { ComposerModelPicker, type ModelChoice } from "./ModelPicker";
import type { PickerAccounts } from "./ModelPickerAccounts";

interface OrclingConversation {
  /** Orclings a message here can ask with `@`. */
  mentions: MentionEntry[] | undefined;
  /** The composer's model control, with Orclings offered beside models; undefined keeps the plain picker. */
  modelControl: ReactNode;
  /** Sends a message that asks an Orcling to it instead of the conversation's agent. False when it names none. */
  ask(text: string, attachments: string[]): Promise<boolean>;
  /** Bylines for guest Orclings' runs, and the face of the Orcling working here. */
  voice: ConversationVoice;
  /** The composer's placeholder when an Orcling works here. */
  placeholder: string | undefined;
  /** What an Orcling's own conversation shows before its first message. */
  empty: ReactNode;
  /** How a group chat's messages go out: to its Orclings, not to one agent. */
  route?: ((message: OutgoingMessage) => Promise<void>) | undefined;
}

/** The Orcling chat a conversation is, if any: an Orcling's own or a group's, with which Orcling spoke in each run. */
function useOrclingChat(thread: ThreadSummary | null, runs: readonly Run[], orclings: readonly Orcling[]): { chat?: OrclingChatSpec; home?: Orcling } {
  const groups = useOrclingGroups();
  const threadId = thread?.id;
  return useMemo(() => {
    if (!threadId) return {};
    const home = orclingHome(orclings, threadId);
    const group = groups.find((candidate) => candidate.threadId === threadId);
    if (!home && !group) return {};
    const members = home ? [home] : group!.memberIds.flatMap((id) => orclingById(orclings, id) ?? []);
    const speakers = new Map(
      runs.flatMap((run) => (run.orclingId ? [[run.id, orclingById(orclings, run.orclingId)] as const] : [])).filter((entry): entry is readonly [string, Orcling] => entry[1] !== null),
    );
    return { chat: { threadId, members, speakers, group: Boolean(group) }, ...(home ? { home } : {}) };
  }, [threadId, orclings, groups, runs]);
}

/** Bylines for guest Orclings' runs, the face of the Orcling working here, and the chat it is, if any. */
function useVoice(runs: readonly Run[], orclings: readonly Orcling[], speaker: Orcling | null, chat: OrclingChatSpec | undefined): ConversationVoice {
  return useMemo(() => {
    const guest = (run: Run) => (run.orclingId && run.orclingId !== speaker?.id ? [[run.id, orclingById(orclings, run.orclingId)?.name ?? "An Orcling"] as const] : []);
    return { authors: new Map(runs.flatMap(guest)), face: speaker ? face(speaker) : undefined, chat };
  }, [runs, orclings, speaker, chat]);
}

/** A group chat's own parts: who it is with in the composer and before the first message, and where its messages go. */
function groupParts(chat: OrclingChatSpec, runs: number, send: (params: { threadId: string; text: string; attachments?: string[]; messageId?: string }) => Promise<unknown>) {
  const names = memberNames(chat.members);
  return {
    placeholder: `Message ${names}…`,
    empty: runs === 0 ? <Empty title={`Say hi to ${names}`} icon={<OrclingGathering members={chat.members} />} /> : undefined,
    mentions: orclingMentionEntries(chat.members, null),
    modelControl: <OrclingFaces members={chat.members} size={22} className="composer-orcling-faces" />,
    route: async ({ text, attachments, messageId }: OutgoingMessage) => {
      await send({ threadId: chat.threadId, text, ...(attachments.length ? { attachments } : {}), ...(messageId ? { messageId } : {}) });
    },
  };
}

/** An Orcling at the tail of its conversation, thinking while a turn runs. */
const face = (orcling: Orcling) => (working: boolean) => <OrclingPreview look={orcling.look} expression={working ? 1 : 0} size={44} />;

/**
 * How Orclings join an ordinary conversation: asked by name with `@`, answering as guests, or chosen in the model
 * picker to work in a project conversation. An Orcling's own conversation and team conversations have their own ways.
 */
export function useOrclingConversation({
  thread,
  runs,
  choice,
  onModel,
  accounts,
}: {
  thread: ThreadSummary | null;
  runs: readonly Run[];
  choice: ModelChoice | null;
  onModel: (choice: ModelChoice) => void;
  /** The conversation's Claude accounts, offered while no Orcling works in it; an Orcling brings its own. */
  accounts?: PickerAccounts | undefined;
}): OrclingConversation {
  const orclings = useOrclings();
  const speaker = orclingById(orclings, thread?.orclingId);
  const { chat, home } = useOrclingChat(thread, runs, orclings);
  const voice = useVoice(runs, orclings, speaker, chat);
  const askOrcling = useRpcMutation("orclings.ask");
  const assign = useRpcMutation("orclings.assign");
  const groupSend = useRpcMutation("orclings.groups.send");
  if (chat?.group) return { voice, ask: async () => false, ...groupParts(chat, runs.length, groupSend.mutateAsync) };
  const open = Boolean(thread && !home && !thread.teamInstanceId && orclings.length);
  const guests = open ? orclings.filter((orcling) => orcling.id !== thread?.orclingId) : [];
  const assignable = open && thread?.projectId !== WORKSPACE_ID;
  return {
    voice,
    placeholder: speaker ? `Message ${speaker.name}…` : undefined,
    empty: home && runs.length === 0 ? <Empty title={`Say hi to ${home.name}`} icon={<OrclingPreview look={home.look} size={160} />} /> : undefined,
    mentions: open ? orclingMentionEntries(orclings, thread?.orclingId) : undefined,
    modelControl:
      assignable && thread ? (
        <ComposerModelPicker
          value={choice}
          onChange={onModel}
          onSelectModel={(next) => {
            // A plain model takes the conversation back from its Orcling.
            if (thread.orclingId) assign.mutate({ threadId: thread.id, orclingId: null });
            onModel(next);
          }}
          orclings={{ options: orclings, selectedId: thread.orclingId ?? null, onSelect: (orcling) => assign.mutate({ threadId: thread.id, orclingId: orcling.id }) }}
          accounts={thread.orclingId ? undefined : accounts}
        />
      ) : undefined,
    async ask(text, attachments) {
      const orcling = thread ? mentionedOrcling(text, guests) : null;
      if (!thread || !orcling) return false;
      await askOrcling.mutateAsync({ id: orcling.id, threadId: thread.id, prompt: text, attachments });
      return true;
    },
  };
}
