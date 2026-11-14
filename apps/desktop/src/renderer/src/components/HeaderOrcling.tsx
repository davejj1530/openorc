import { Popover } from "@base-ui/react/popover";
import { conversationActivity, conversationSendDisabledReason, conversationSteerReason, heardTranscript, processFit, type SubmitRequest } from "@openorc/client";
import type { Orcling, ThreadSummary } from "@openorc/protocol";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { CoversPreview } from "../lib/browser-preview";
import { useConversationSettings, useConversationTranscript, useRpc, useRpcs, useSubmit } from "../lib/client";
import { useConversationDraft } from "../lib/conversation-draft";
import { modelLabel } from "../lib/model-effort-label";
import { headerOrcling, orclingById, useOrclings } from "../lib/orclings";
import { useReadWhileShown } from "../lib/read-while-shown";
import { useRouter } from "../lib/router";
import { floatingGround } from "../lib/use-anchor-ground";
import { Composer } from "./Composer";
import { Maximize2 } from "./icons";
import { OrclingAvatar } from "./OrclingAvatar";
import { OrclingChat } from "./OrclingChat";
import { UnreadMark } from "./StateMarks";
import { BlockView } from "./Transcript";
import { IconButton, Tooltip } from "./ui";
import { useOptimisticSend } from "./useOptimisticSend";

const NO_PANES: readonly string[] = [];

/** Under the face, its right edge on the face's. */
const PLACE = { side: "bottom", align: "end", sideOffset: 8 } as const;

/**
 * An Orcling's face at the header's end: the one with the newest unread message, else the one talked to last, with the
 * unread dot while she has said something unread. It opens a small chat with her over the work, which only a press
 * opens, and which Escape or a press outside closes, giving focus back to the face.
 */
export function HeaderOrcling() {
  const orclings = useOrclings();
  const chats = useRpcs(
    "threads.get",
    orclings.map((orcling) => ({ id: orcling.threadId })),
  );
  const shown = useRouter((state) => (state.route.view === "thread" ? state.threadIds : NO_PANES));
  const [open, setOpen] = useState(false);
  // Inside the app's shell, where the chat's messages take their type and their bubbles.
  const [shell, setShell] = useState<HTMLElement | null>(null);
  const picked = headerOrcling(
    orclings,
    chats.map((chat) => chat.data),
    shown,
  );
  // While her chat is open she stays its subject, whatever lands from the others.
  const [held, setHeld] = useState<string | null>(null);
  const orcling = (open && orclingById(orclings, held)) || picked;
  if (!orcling) return null;
  const chat = chats[orclings.indexOf(orcling)]?.data;
  const label = `Chat with ${orcling.name}`;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setHeld(next ? orcling.id : null);
        setOpen(next);
      }}
    >
      <Tooltip label={label}>
        <Popover.Trigger render={<IconButton ref={(face) => setShell(face?.closest<HTMLElement>(".app-shell") ?? null)} aria-label={label} className="header-orcling no-drag" />}>
          <OrclingAvatar orcling={orcling} size={18} />
          {chat?.unread ? <UnreadMark /> : null}
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal container={shell ?? undefined}>
        <CoversPreview />
        <Popover.Positioner {...PLACE} collisionPadding={8} className="z-50">
          <Popover.Popup ref={floatingGround} className="floating-popover orcling-small-chat no-drag" aria-label={label} initialFocus={false}>
            {chat ? <SmallChat orcling={orcling} thread={chat} onLeave={() => setOpen(false)} /> : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Her name and model, the way into her full chat, her latest messages as her chat draws them, and a line to her. */
function SmallChat({ orcling, thread, onLeave }: { orcling: Orcling; thread: ThreadSummary; onLeave: () => void }) {
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  const talk = useSmallChatSend(thread);
  const spec = useMemo(() => ({ threadId: thread.id, members: [orcling], speakers: new Map(talk.runs.map((run) => [run.id, orcling])), group: false }), [thread.id, orcling, talk.runs]);
  const scroller = useRef<HTMLDivElement>(null);
  const blocks = talk.run?.blocks ?? [];
  useReadWhileShown(thread);
  // The newest message is the one in view, as it is in her full chat.
  useLayoutEffect(() => {
    const body = scroller.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [blocks.length, talk.typing]);
  return (
    <>
      <div className="orcling-small-chat-head">
        <OrclingAvatar orcling={orcling} size={18} className="shrink-0" />
        <span className="truncate">{orcling.name}</span>
        <span className="flex-1 min-w-0 truncate text-ink-3">{modelLabel(orcling.settings, models.data)}</span>
        <Tooltip label="Open chat">
          <IconButton
            size="xs"
            aria-label="Open chat"
            onClick={() => {
              onLeave();
              useRouter.getState().navigate({ view: "thread", threadId: thread.id });
            }}
          >
            <Maximize2 size={14} />
          </IconButton>
        </Tooltip>
      </div>
      <div ref={scroller} className="orcling-small-chat-body">
        <OrclingChat chat={spec} blocks={blocks} live={talk.typing} card={(block) => <BlockView block={block} runId={block.runId ?? talk.run?.runId ?? ""} taskCards actions={false} />} />
      </div>
      <Composer {...talk.composer} presentation="small" placeholder={`Message ${orcling.name}…`} />
    </>
  );
}

/** Her conversation as recorded with the messages on their way, and a composer that sends as her full chat's does. */
function useSmallChatSend(thread: ThreadSummary) {
  const runsQuery = useRpc("runs.listForThread", { threadId: thread.id });
  const runs = useMemo(() => runsQuery.data ?? [], [runsQuery.data]);
  const activeRun = runs.at(-1);
  const { merged, liveTranscript } = useConversationTranscript({ runs, threadId: thread.id });
  const settings = useConversationSettings({ thread, activeRun });
  const { choice, mode, permission, permissionReady } = settings;
  const draftKey = `conversation.${thread.id}`;
  const { prompt, setPrompt, clearDraft } = useConversationDraft({ draftKey, threadId: thread.id, initialText: thread.draft ?? "" });
  const submitter = useSubmit();
  const { live, working } = conversationActivity({ thread, activeRun, liveTranscript, compacting: false });
  const { sameAgent, settingsPending, canSteer } = processFit({ live, activeRun, choice, mode, permission, compacting: false });
  const request: Omit<SubmitRequest, "now"> = {
    target: { kind: "thread", threadId: thread.id },
    working,
    live,
    activeRun,
    agentsUsed: runs.map((run) => run.agent),
    choice,
    mode,
    permission,
    permissionReady,
    compacting: false,
    waitForSave: settings.waitForSave,
  };
  const optimistic = useOptimisticSend({ submitter, request, run: merged, attachmentsKey: `${draftKey}.attachments`, restore: setPrompt });
  const disabledReason = conversationSendDisabledReason({ permissionReady, historyLoading: runsQuery.isLoading, historyFailed: Boolean(runsQuery.error), hasModel: Boolean(choice), thread });
  const run = optimistic.run ? heardTranscript(optimistic.run, thread) : null;
  return {
    runs,
    run,
    /** She is typing: a turn of hers runs, as her full chat reads it. */
    typing: working || Boolean(run?.turnOpen),
    composer: {
      draftKey: `${draftKey}.attachments`,
      value: prompt,
      onChange: setPrompt,
      onSubmit: async (text: string, attachments: string[], now: boolean) => {
        await optimistic.send({ ...request, now }, { text, attachments });
        clearDraft();
      },
      model: choice,
      onModel: settings.selectModel,
      mode,
      onMode: settings.selectMode,
      permission,
      onPermission: settings.selectPermission,
      location: { label: null, branch: null },
      hasStarted: true,
      busy: optimistic.busy,
      disabledReason,
      live: live && activeRun ? { runId: activeRun.id, working } : null,
      queueing: working,
      liveByDefault: true,
      steerable: canSteer,
      steerReason: conversationSteerReason({ canSteer, compacting: false, settingsPending, sameAgent, agent: activeRun?.agent }),
      error: submitter.error?.message ?? null,
    },
  };
}
