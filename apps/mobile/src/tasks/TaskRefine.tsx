import { sameTaskDocument, type Task, type TaskRefine as Refine, type TaskSuggestion } from "@openorc/protocol";
import { router } from "expo-router";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Markdown } from "../thread/Markdown";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { WorkingMark } from "../ui/StateMark";
import { Text } from "../ui/Text";
import { suggestionBlocks, type SuggestionBlock } from "./refine-blocks";
import { holdsSecret } from "./task-edit";
import { useRefinerName, type TaskRefineView } from "./use-task-refine";

/** Opens the sheet that starts a Refine: a first one, or one that builds on the suggestion showing. */
export const openRefine = (taskId: string, again = false) => router.push({ pathname: "/task-refine", params: again ? { id: taskId, again: "1" } : { id: taskId } });

const SECRET_SUGGESTION = "This suggestion holds a secret, so use it on your Mac.";

/** One of the bar's plain actions. */
function Action({ label, disabled = false, onPress }: { label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      hitSlop={{ top: 10, bottom: 10 }}
      className={cn("h-control-sm justify-center rounded-full bg-key px-3 active:bg-surface-3", disabled && "opacity-50")}
    >
      <Text className="text-sm text-ink-2">{label}</Text>
    </Pressable>
  );
}

/** Every state's card, so the status stays one region and VoiceOver announces each change. */
function RefineCard({ lead, who, step, note, failure, children }: { lead?: ReactNode; who: string; step?: string; note?: ReactNode; failure: string | null; children: ReactNode }) {
  return (
    <View accessibilityLiveRegion="polite" className="gap-3 rounded-3xl bg-surface px-4 py-3.5">
      <View className="flex-row items-center gap-2.5">
        {lead}
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-md">{who}</Text>
          {step === undefined ? null : (
            <Text numberOfLines={1} className="text-sm text-ink-4">
              {step}
            </Text>
          )}
        </View>
      </View>
      {note}
      {failure ? (
        <Text accessibilityRole="alert" selectable className="text-sm text-bad">
          {failure}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap items-center gap-2">{children}</View>
    </View>
  );
}

/** What the person asked for, then what the agent says of its try. */
function RefineNote({ refine, children }: { refine: Refine; children?: ReactNode }) {
  if (!refine.instruction && !children) return null;
  return (
    <Text selectable className="text-sm text-ink-3">
      {refine.instruction ? <Text className="text-sm text-ink-4">{`You asked “${refine.instruction}”. `}</Text> : null}
      {children}
    </Text>
  );
}

/** The suggested title: alone where it is the task's, else under the one it replaces, struck. */
function SuggestedTitle({ before, after }: { before: string; after: string }) {
  const changed = before.trim() !== after.trim();
  return (
    <View className="gap-1">
      {changed && before.trim() ? <Text className="text-md text-ink-4 line-through">{before}</Text> : null}
      <Text selectable className={cn("text-2xl", changed && "text-ok")}>
        {after}
      </Text>
    </View>
  );
}

/** The suggested labels, a new one in green and one the suggestion drops struck; nothing where they are the task's. */
function SuggestedLabels({ before, after }: { before: string[]; after: string[] }) {
  const removed = before.filter((label) => !after.includes(label));
  if (!removed.length && after.every((label) => before.includes(label))) return null;
  return (
    <View accessible accessibilityLabel={`Suggested labels: ${after.join(", ") || "none"}`} className="flex-row flex-wrap items-center gap-x-2.5 gap-y-1">
      <Text className="text-detail text-ink-4">Labels</Text>
      {after.map((label) => (
        <Text key={label} className={cn("text-detail text-ink-2", !before.includes(label) && "text-ok")}>
          {label}
        </Text>
      ))}
      {removed.map((label) => (
        <Text key={label} className="text-detail text-ink-4 line-through">
          {label}
        </Text>
      ))}
    </View>
  );
}

const bars: Record<SuggestionBlock["kind"], string | null> = { same: null, added: "bg-ok", changed: "bg-ok", removed: "bg-bad" };

/** One block of the suggested description. A new or reworded block wears a green bar; one the suggestion drops shows struck beside a red one. */
function Block({ block }: { block: SuggestionBlock }) {
  const bar = bars[block.kind];
  return (
    <View className="flex-row gap-3">
      <View className={cn("w-0.5 rounded-full", bar)} />
      <View className="min-w-0 flex-1">
        {block.kind === "removed" ? (
          <Text prose selectable className="text-md text-ink-4 line-through">
            {block.text}
          </Text>
        ) : (
          <Markdown text={block.text} streaming={false} />
        )}
      </View>
    </View>
  );
}

/**
 * A suggestion in place of the task's description, its changes marked: the title, the labels where they change, and
 * the description block by block. The task changes only when Use suggestion is pressed.
 */
function Suggestion({ task, refine, suggestion, name, view }: { task: Task; refine: Refine; suggestion: TaskSuggestion; name: string; view: TaskRefineView }) {
  const [asked, setAsked] = useState(false);
  const current = { title: task.title, spec: task.spec ?? "", labels: task.labels };
  const blocks = useMemo(() => suggestionBlocks(current.spec, suggestion.description), [current.spec, suggestion.description]);
  // The phone reads both texts with secrets redacted, so a suggestion that shows one, or would replace one, is used on the Mac.
  const held = holdsSecret(suggestion.description) || holdsSecret(task.spec) ? SECRET_SUGGESTION : null;
  const movedOn = !sameTaskDocument(refine.base, current);
  const use = () => {
    if (!held) return view.use(suggestion);
    haptic.warn();
    setAsked(true);
  };
  return (
    <View className="gap-5">
      <RefineCard
        who={`Suggested by ${name}`}
        failure={view.failure ?? (refine.error ? `Refining again didn’t finish: ${refine.error}` : null)}
        note={
          <RefineNote refine={refine}>
            {suggestion.note}
            {movedOn ? " Suggested from an earlier version. Changes to the task since aren’t in it." : null}
          </RefineNote>
        }
      >
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: Boolean(held) || view.closing }}
          disabled={view.closing}
          onPress={use}
          className={cn("h-control-sm justify-center rounded-full bg-accent px-3 active:opacity-80", (held || view.closing) && "bg-surface-3")}
        >
          <Text className={cn("text-sm text-accent-fg", (held || view.closing) && "text-ink-3")}>Use suggestion</Text>
        </Pressable>
        <Action label="Refine again" disabled={view.closing} onPress={() => openRefine(task.id, true)} />
        <Action label="Dismiss" disabled={view.closing} onPress={view.close} />
        {asked && held ? <Text className="w-full text-sm text-ink-3">{held}</Text> : null}
      </RefineCard>
      <SuggestedTitle before={current.title} after={suggestion.title} />
      <SuggestedLabels before={current.labels} after={suggestion.labels} />
      <View accessibilityLabel="Suggested task description" className="gap-3.5">
        {blocks.map((block, index) => (
          <Block key={index} block={block} />
        ))}
      </View>
    </View>
  );
}

/**
 * A task's Refine on its page: the agent at work with its latest step and Stop; how a try ended with nothing to use;
 * or its suggestion, which takes the description's place. Nothing while there is none.
 */
export function TaskRefine({ task, view }: { task: Task; view: TaskRefineView }) {
  const { refine } = view;
  const name = useRefinerName(refine?.recipient);
  if (!refine) return null;
  if (refine.state === "running")
    return (
      <RefineCard lead={<WorkingMark />} who={`${name} is refining…`} step={refine.step ?? "Reading the task"} failure={view.failure} note={<RefineNote refine={refine} />}>
        <Action label="Stop" disabled={view.stopping} onPress={view.stop} />
      </RefineCard>
    );
  if (refine.state === "ready" && refine.suggestion) return <Suggestion task={task} refine={refine} suggestion={refine.suggestion} name={name} view={view} />;
  const unchanged = refine.state === "unchanged";
  return (
    <RefineCard
      who={unchanged ? `${name} found nothing to change.` : `${name} couldn’t finish refining.`}
      failure={view.failure}
      note={<RefineNote refine={refine}>{unchanged ? refine.suggestion?.note : refine.error}</RefineNote>}
    >
      {unchanged ? null : <Action label="Try again" onPress={() => openRefine(task.id)} />}
      <Action label="Dismiss" disabled={view.closing} onPress={view.close} />
    </RefineCard>
  );
}

/** Whether a suggestion stands in the description's place. */
export const showsSuggestion = (view: TaskRefineView): boolean => view.refine?.state === "ready" && view.refine.suggestion !== null;
