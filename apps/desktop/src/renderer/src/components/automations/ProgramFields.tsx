import type { AccountsProject } from "@openorc/client";
import { isHarnessId, type AutomationTrigger, type ThreadChoice, type TriggerState } from "@openorc/protocol";
import { useState } from "react";
import { cn } from "../../lib/cn";
import { useRpc, useRpcMutation } from "../../lib/client";
import { useDefaultAgent } from "../../lib/default-harness";
import { useLayout } from "../../lib/layout";
import { openThread } from "../../lib/router";
import { useModelCatalog } from "../../lib/use-model-catalog";
import { AgentBrief } from "../AgentBrief";
import { defaultChoice } from "../ModelPicker";
import { Button, Input } from "../ui";

type ProgramTrigger = Extract<AutomationTrigger, { kind: "program" }>;
export type WriterChoice = { choice: ThreadChoice | null; choose: (choice: ThreadChoice | null) => void };

const RECENT = 5;

/** The model a trigger program is written on: the one picked, else the default of the agent new work starts on. */
export function useWriterChoice(): WriterChoice {
  const [picked, choose] = useState<ThreadChoice | null>(null);
  const models = useModelCatalog();
  const agent = useDefaultAgent() ?? null;
  const fallback = models.data ? defaultChoice(models.data, agent) : null;
  const usual = fallback && isHarnessId(fallback.agent) ? { agent: fallback.agent, model: fallback.model, effort: fallback.effort } : null;
  return { choice: picked ?? usual, choose };
}

/** Its code beside the agent that writes it: the agent's thread, with the program's files open in the panel. */
function openCode(threadId: string): void {
  openThread(threadId);
  useLayout.getState().openFile({ scope: { kind: "thread", id: threadId }, path: "trigger.json" });
}

/** How it runs, in a few words: being written, waiting for a value, listening, tried, stopped and why, or off. */
function statusOf(trigger: TriggerState, enabled: boolean): { text: string; bad: boolean } {
  if (!trigger.run) return { text: trigger.threadId ? "An agent is writing it." : "Its program isn't written yet.", bad: false };
  const missing = trigger.env.filter((value) => !value.added).map((value) => value.name);
  if (missing.length > 0) return { text: `Add ${missing.join(", ")} to start it.`, bad: false };
  if (trigger.state === "stopped") return { text: trigger.problem ?? "It stopped.", bad: true };
  if (trigger.state === "listening") return { text: "Listening.", bad: false };
  if (trigger.state === "trying") return { text: "Trying it. Nothing it finds is acted on.", bad: false };
  return { text: enabled ? "Starting." : "Off.", bad: false };
}

/** One value the program reads, such as a token: its name, where to get it, and a field that keeps it once left. */
function ProgramValue({ id, value }: { id: string; value: TriggerState["env"][number] }) {
  const save = useRpcMutation("automations.setTriggerValue");
  const [text, setText] = useState("");
  return (
    <label className="automation-program-value">
      <span className="automation-program-value-name">{value.name}</span>
      {value.about ? <span className="automation-program-value-about">{value.about}</span> : null}
      <Input
        type="password"
        aria-label={value.name}
        autoComplete="off"
        spellCheck={false}
        value={text}
        placeholder={value.added ? "Added" : "Paste the value"}
        disabled={save.isPending}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (text) save.mutate({ id, name: value.name, value: text }, { onSuccess: () => setText("") });
        }}
      />
      {save.error ? (
        <span className="text-bad" role="alert">
          {save.error.message}
        </span>
      ) : null}
    </label>
  );
}

/** A written program: how it runs, the values it needs, what it printed lately, and its code beside its agent. Off, it can be tried. */
function ProgramPanel({ id, enabled }: { id: string; enabled: boolean }) {
  const read = useRpc("automations.trigger", { id });
  const tryIt = useRpcMutation("automations.tryTrigger");
  const trigger = read.data;
  const agent = useRpc("threads.get", { id: trigger?.threadId ?? "" }, { enabled: Boolean(trigger?.threadId) });
  if (!trigger) return null;
  const status = statusOf(trigger, enabled);
  const trying = trigger.state === "trying";
  return (
    <div className="automation-program">
      <div className="automation-program-head">
        <p className={cn("automation-program-status", status.bad && "text-bad")} role="status">
          {status.text}
        </p>
        {!enabled && trigger.run ? (
          <Button size="sm" disabled={tryIt.isPending} onClick={() => tryIt.mutate({ id, on: !trying })}>
            {trying ? "Stop" : "Try it"}
          </Button>
        ) : null}
        {trigger.threadId ? (
          <Button size="sm" onClick={() => openCode(trigger.threadId!)}>
            Open the code
          </Button>
        ) : null}
      </div>
      {agent.data?.activity === "waiting" ? <p className="automation-program-asks">Its agent is waiting for you in its thread.</p> : null}
      {trigger.env.length > 0 ? (
        <div className="automation-program-values">
          {trigger.env.map((value) => (
            <ProgramValue key={value.name} id={id} value={value} />
          ))}
        </div>
      ) : null}
      {trigger.recent.length > 0 ? (
        <ul className="automation-program-recent" aria-label="What it printed lately">
          {trigger.recent.slice(-RECENT).map((line) => (
            <li key={`${line.at}:${line.text}`} className={cn(!line.event && "automation-program-said")}>
              {line.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * A trigger the person describes, as a program an agent writes. A new one is what to watch for and the model its agent
 * writes it on, written as the automation is created; a written one keeps its words, and shows how its program runs.
 */
export function ProgramFields({
  trigger,
  project,
  writer,
  enabled,
  onChange,
}: {
  trigger: ProgramTrigger;
  project: AccountsProject | undefined;
  writer: WriterChoice;
  /** Whether its automation is switched on, so its program runs for it rather than being tried. */
  enabled: boolean;
  onChange: (trigger: ProgramTrigger) => void;
}) {
  if (!trigger.id)
    return (
      <AgentBrief
        words={trigger.what}
        onWords={(what) => onChange({ ...trigger, what })}
        choice={writer.choice}
        onChoice={writer.choose}
        project={project}
        label="What to watch for"
        maxLength={200}
        rows={2}
        showEffort={false}
        placeholder="Describe what to watch for, such as: someone messages me on Slack"
      />
    );
  return (
    <>
      <Input aria-label="What it watches for" value={trigger.what} maxLength={200} onChange={(event) => onChange({ ...trigger, what: event.target.value })} />
      <ProgramPanel id={trigger.id} enabled={enabled} />
    </>
  );
}
