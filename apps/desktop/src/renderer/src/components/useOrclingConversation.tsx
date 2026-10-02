import { useMemo, type ReactNode } from "react";
import { WORKSPACE_ID, type Orcling, type Run, type ThreadSummary } from "@openorc/protocol";
import type { MentionEntry } from "../lib/composer-mentions";
import { mentionedOrcling, orclingById, orclingHome, orclingMentionEntries, useOrclings } from "../lib/orclings";
import type { ConversationVoice } from "../lib/turn-authors";
import { OrclingPreview } from "./OrclingPreview";
import { Empty } from "./ui";
import { useRpcMutation } from "../lib/query";
import { ComposerModelPicker, type ModelChoice } from "./ModelPicker";

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
}: {
  thread: ThreadSummary | null;
  runs: readonly Run[];
  choice: ModelChoice | null;
  onModel: (choice: ModelChoice) => void;
}): OrclingConversation {
  const orclings = useOrclings();
  const own = thread?.orclingId ?? null;
  const speaker = orclingById(orclings, own);
  const voice = useMemo(
    () => ({
      authors: new Map(runs.flatMap((run) => (run.orclingId && run.orclingId !== own ? [[run.id, orclings.find((orcling) => orcling.id === run.orclingId)?.name ?? "An Orcling"] as const] : []))),
      face: speaker ? face(speaker) : undefined,
    }),
    [runs, own, orclings, speaker],
  );
  const askOrcling = useRpcMutation("orclings.ask");
  const assign = useRpcMutation("orclings.assign");
  const home = orclingHome(orclings, thread?.id);
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
