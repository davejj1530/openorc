import { approvalDetail, approvalSummary, isImageGeneration, type Block, type Question, readQuestions } from "@openorc/client";
import { harnessShortName, isHarnessId } from "@openorc/protocol";
import * as Haptics from "expo-haptics";
import { memo, useRef, useState } from "react";
import { Pressable, TextInput, useWindowDimensions, View } from "react-native";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { client } from "../client";
import { AlertCircle, Check, Hammer, Image as ImageIcon, Terminal, X } from "../generated/icons";
import { cn } from "../ui/cn";
import { HarnessLogo } from "../ui/HarnessLogo";
import { useColors } from "../ui/mode";
import { arrive, confirm, ease } from "../ui/motion";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { ImageTile } from "./images";
import { ActivityRow, ToolRow } from "./tools";
import { useVoice } from "./voices";

type ApprovalBlock = Extract<Block, { kind: "approval" }>;
type Decision = "allow" | "allow_for_run" | "deny";

/** Answers an agent's request once; a second tap while the answer is on its way does nothing. */
function useResolve(runId: string, approvalId: string) {
  const resolve = client.useRpcMutation("approvals.resolve");
  return {
    pending: resolve.isPending,
    error: resolve.error?.message ?? null,
    send(decision: Decision, answers?: Record<string, string[]>) {
      if (resolve.isPending) return;
      void Haptics.notificationAsync(decision === "deny" ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success);
      resolve.mutate({ runId, approvalId, decision, ...(answers ? { answers } : {}) });
    },
  };
}

function pretty(value: unknown, max: number): string {
  if (value === null || value === undefined || (typeof value === "object" && Object.keys(value).length === 0)) return "no arguments";
  const text = typeof value === "string" ? value : (JSON.stringify(value, null, 1) ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function Pill({ label, primary = false, disabled, onPress }: { label: string; primary?: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      className={cn("h-touch flex-1 items-center justify-center rounded-full px-4", primary ? "bg-accent active:opacity-80" : "bg-surface-2 active:bg-surface-3", disabled && "opacity-60")}
    >
      <Text numberOfLines={1} className={cn("text-md", primary && "text-accent-fg")}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A refusal keeps one quiet line in the turn; an allowed call already shows as its tool row. */
function DeniedLine({ block }: { block: ApprovalBlock }) {
  return (
    <View className="h-touch flex-row items-center gap-2.5 rounded-full bg-surface pl-4 pr-4.5">
      <X size={16} className="text-bad" />
      <Text>Denied</Text>
      <Text numberOfLines={1} className="min-w-0 flex-1 font-mono text-xs text-ink-4">
        {block.toolName ?? block.approvalKind}
      </Text>
    </View>
  );
}

/** The agent asks before it acts: what it wants to do, then Deny, Allow for this run and Allow, the one ink pill. */
export function ApprovalCard({ block, runId }: { block: ApprovalBlock; runId: string }) {
  const { width } = useWindowDimensions();
  const resolve = useResolve(runId, block.approvalId);
  const [raw, setRaw] = useState(false);
  if (block.decision && block.decision !== "deny") return null;
  if (block.decision) return <DeniedLine block={block} />;
  const detail = approvalDetail(block);
  const Icon = typeof detail === "string" ? Terminal : Hammer;
  const stacked = width < 420;
  return (
    <View className="gap-3 rounded-2xl bg-surface p-4">
      <View className="flex-row items-start gap-3">
        <View className="size-9 items-center justify-center rounded-md bg-surface-2">
          <Icon size={16} className="text-ink-3" />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-md leading-5">{block.reason ?? `Allow ${block.toolName ?? block.approvalKind}?`}</Text>
          <Text selectable className="font-mono text-xs leading-4 text-ink-4">
            {raw ? pretty(block.input, 800) : approvalSummary(block)}
          </Text>
          <Pressable accessibilityRole="button" onPress={() => setRaw(!raw)} hitSlop={8} className="self-start active:opacity-60">
            <Text className="text-xs leading-4 text-ink-4">{raw ? "Summary" : "Raw request"}</Text>
          </Pressable>
        </View>
      </View>
      <View className={cn("gap-2", !stacked && "flex-row")}>
        <Pill label="Deny" disabled={resolve.pending} onPress={() => resolve.send("deny")} />
        {block.onceOnly ? null : <Pill label="Allow for this run" disabled={resolve.pending} onPress={() => resolve.send("allow_for_run")} />}
        <Pill label="Allow" primary disabled={resolve.pending} onPress={() => resolve.send("allow")} />
      </View>
      {resolve.error ? <Text className="text-sm text-bad">{resolve.error}</Text> : null}
    </View>
  );
}

/** What the card asks of the reader, in a few words. */
function askHint(questions: Question[]): string {
  if (!questions.some((q) => q.options)) return "Type your answer";
  const pick = questions.some((q) => q.multi) ? "Pick any" : "Pick one";
  return questions.some((q) => q.options && q.allowOther) ? `${pick}, or type your own` : pick;
}

type OptionState = "open" | "picked" | "chosen" | "dropped";

/** The check on a picked or chosen option, landing with an overshoot when picked here and now. */
function OptionCheck({ chosen, asked }: { chosen: boolean; asked: boolean }) {
  const still = useReducedMotion();
  return (
    <Animated.View style={asked && !still ? confirm : undefined}>
      <Check size={16} className={chosen ? "text-accent-fg" : "text-ink"} />
    </Animated.View>
  );
}

/**
 * One option as a 44 pt r12 row. Picking it marks it with a check that lands with an overshoot; once the answer is
 * sent the chosen rows take the ink pill and the rest step back, one after another. A card that was already answered
 * when it mounted (`asked` false) shows its check at once.
 */
function Option(props: { option: { label: string; description: string }; state: OptionState; index: number; asked: boolean; onPress: () => void }) {
  const { option, state, index, asked, onPress } = props;
  const palette = useColors();
  const still = useReducedMotion();
  const background = { open: palette["surface-2"], picked: palette["surface-3"], chosen: palette.accent, dropped: palette["surface-2"] }[state];
  const chosen = state === "chosen";
  const settled = chosen || state === "dropped";
  return (
    <Animated.View
      style={{
        backgroundColor: background,
        opacity: state === "dropped" ? 0.4 : 1,
        borderRadius: 12,
        ...(still ? {} : { transitionProperty: ["backgroundColor", "opacity"], transitionDuration: 220, transitionDelay: state === "dropped" ? index * 40 : 0, transitionTimingFunction: ease.out }),
      }}
    >
      <Pressable
        accessibilityRole={settled ? "text" : "radio"}
        accessibilityState={{ checked: state === "picked" || chosen }}
        disabled={settled}
        onPress={onPress}
        className="min-h-touch flex-row items-center gap-2.5 p-3"
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className={cn("leading-4", chosen && "text-accent-fg")}>{option.label}</Text>
          {option.description ? <Text className={cn("text-xs text-ink-3", chosen && "text-accent-fg")}>{option.description}</Text> : null}
        </View>
        {state === "picked" || chosen ? <OptionCheck chosen={chosen} asked={asked} /> : null}
      </Pressable>
    </Animated.View>
  );
}

/** The foot swaps in place: a hint with Decline and Answer while it waits, then where the answer went. */
function QuestionFoot(props: { decided: string | undefined; asked: boolean; agent: string | null; hint: string; ready: boolean; pending: boolean; onDecline: () => void; onAnswer: () => void }) {
  const still = useReducedMotion();
  if (props.decided)
    return (
      <Animated.View style={props.asked && !still ? arrive : undefined}>
        <Text accessibilityRole="text" className="text-xs leading-4 text-ink-4">
          {props.decided === "deny" ? "Declined" : `Sent to ${props.agent ?? "the agent"}`}
        </Text>
      </Animated.View>
    );
  return (
    <View className="flex-row items-center gap-1.5">
      <Text className="min-w-0 flex-1 text-xs leading-4 text-ink-4">{props.hint}</Text>
      <Pressable accessibilityRole="button" disabled={props.pending} onPress={props.onDecline} className="h-control-xl justify-center rounded-full px-3.5 active:bg-surface-2">
        <Text>Decline</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        disabled={!props.ready}
        onPress={props.onAnswer}
        className={cn("h-control-xl justify-center rounded-full bg-accent px-4 active:opacity-80", !props.ready && "bg-surface-3")}
      >
        <Text className={cn("text-accent-fg", !props.ready && "text-ink-3")}>Answer</Text>
      </Pressable>
    </View>
  );
}

/** An agent asked something. Each question gets its options or a text field; one Answer sends them all. */
export function QuestionCard({ block, runId }: { block: ApprovalBlock; runId: string }) {
  const questions = readQuestions(block.input);
  const voice = useVoice(runId);
  const resolve = useResolve(runId, block.approvalId);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const asked = useRef(!block.decision).current;
  const decided = block.decision;

  const answerFor = (q: Question): string[] => {
    const chosen = (picked[q.key] ?? []).filter((value) => value !== "__other");
    const free = (other[q.key] ?? "").trim();
    if ((picked[q.key] ?? []).includes("__other") && free) chosen.push(free);
    if (!q.options && free) return [free];
    return chosen;
  };
  const complete = questions.length > 0 && questions.every((q) => answerFor(q).length > 0);
  const toggle = (q: Question, value: string) => {
    void Haptics.selectionAsync();
    setPicked((state) => {
      const current = state[q.key] ?? [];
      if (q.multi) return { ...state, [q.key]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value] };
      return { ...state, [q.key]: [value] };
    });
  };
  const submit = () => {
    if (!complete) return;
    resolve.send("allow", Object.fromEntries(questions.map((q) => [q.key, answerFor(q)])));
  };
  const chosen = (q: Question): string[] => {
    if (!decided) return picked[q.key] ?? [];
    return decided === "deny" ? [] : (block.answers?.[q.key] ?? []);
  };
  const stateOf = (q: Question, label: string): OptionState => {
    const on = chosen(q).includes(label);
    if (decided) return on ? "chosen" : "dropped";
    return on ? "picked" : "open";
  };

  return (
    <View className="gap-3 rounded-3xl bg-surface p-4">
      {questions.map((q, i) => (
        <View key={q.key} className="gap-3">
          <View className="flex-row items-center gap-2">
            {i === 0 && voice ? <HarnessLogo agent={voice.agent} size={14} /> : null}
            <Text className="min-w-0 flex-1 text-md leading-5">{q.question || q.header}</Text>
          </View>
          <View className="gap-1">
            {q.options?.map((option, index) => (
              <Option key={option.label} option={option} index={index} asked={asked} state={stateOf(q, option.label)} onPress={() => toggle(q, option.label)} />
            ))}
            {!decided && q.allowOther ? (
              <TextInput
                accessibilityLabel={q.options ? `Custom answer: ${q.question}` : q.question}
                placeholder={q.options ? "Something else" : "Your answer"}
                secureTextEntry={q.secret}
                value={other[q.key] ?? ""}
                onFocus={() => q.options && !(picked[q.key] ?? []).includes("__other") && toggle(q, "__other")}
                onChangeText={(value) => setOther((state) => ({ ...state, [q.key]: value }))}
                onSubmitEditing={submit}
                returnKeyType="send"
                className="min-h-touch rounded-lg bg-surface-2 px-3 font-sans text-base text-ink"
                placeholderTextColorClassName="accent-ink-4"
              />
            ) : null}
            {decided && decided !== "deny"
              ? (block.answers?.[q.key] ?? [])
                  .filter((value) => !q.options?.some((option) => option.label === value))
                  .map((value, index) => (
                    <View key={index} className="rounded-lg bg-accent px-3 py-3.5">
                      <Text className="leading-4 text-accent-fg">{q.secret ? "Answer hidden" : value}</Text>
                    </View>
                  ))
              : null}
          </View>
        </View>
      ))}
      <QuestionFoot
        decided={decided}
        asked={asked}
        agent={voice && isHarnessId(voice.agent) ? harnessShortName(voice.agent) : null}
        hint={resolve.error ?? askHint(questions)}
        ready={complete && !resolve.pending}
        pending={resolve.pending}
        onDecline={() => resolve.send("deny")}
        onAnswer={submit}
      />
    </View>
  );
}

/** A failure the person has to act on, in the bad tone. */
function ErrorCard({ text }: { text: string }) {
  return (
    <View className="flex-row items-start gap-2.5 rounded-xl bg-bad-soft px-4 py-3">
      <View className="mt-0.5">
        <AlertCircle size={16} className="text-bad" />
      </View>
      <Text selectable className="min-w-0 flex-1">
        {text.replace(/^API Error:\s*(\d+\s*)?/, "")}
      </Text>
    </View>
  );
}

function imageWords(status: string): string {
  if (status === "running") return "Creating image";
  if (status === "success") return "Created image";
  return "Image failed";
}

/** An image the agent made: a status line, then the image once it is saved on the Mac. */
function ImageGeneration({ block, runId }: { block: Extract<Block, { kind: "activity" }>; runId: string }) {
  const running = block.status === "running";
  return (
    <View className="gap-2">
      <View className="min-h-control-md flex-row items-center gap-2">
        <ImageIcon size={14} className="text-ink-4" />
        <Text className="text-ink-4">{imageWords(block.status)}</Text>
        {running ? <Spinner size={14} /> : null}
      </View>
      {block.status === "success" && block.imagePath ? <ImageTile asset={{ kind: "generated", runId: block.runId ?? runId, activityId: block.id }} label="Generated image" /> : null}
      {block.status === "error" && block.text ? <Text className="text-sm text-bad">{block.text}</Text> : null}
    </View>
  );
}

/** What follows a turn's work and is not its reply: a request, a question, an error, an image, a call that stands alone. */
export const Card = memo(function Card({ block, runId }: { block: Block; runId: string }) {
  switch (block.kind) {
    case "approval":
      return block.approvalKind === "user_input" ? <QuestionCard block={block} runId={runId} /> : <ApprovalCard block={block} runId={runId} />;
    case "message":
      return <ErrorCard text={block.text} />;
    case "status":
      return <ErrorCard text={block.text} />;
    case "activity":
      return isImageGeneration(block) ? <ImageGeneration block={block} runId={runId} /> : <ActivityRow block={block} />;
    case "tool":
      return <ToolRow block={block} runId={runId} />;
    case "thinking":
      return null;
  }
});
