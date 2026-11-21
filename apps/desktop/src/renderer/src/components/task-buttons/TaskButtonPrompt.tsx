import { useId, useRef, useState, type KeyboardEvent } from "react";
import { commandWordAt, insertSkill, rankCommands, useCommandWord, type SkillCommand } from "@openorc/client";
import type { ThreadChoice } from "@openorc/protocol";
import { useDefaultAgent } from "../../lib/default-harness";
import { projectScope, useSkillCommands } from "../../lib/skill-commands";
import { Textarea } from "../ui";

/** A skill a button's prompt can call, by the name it calls it with on any agent. */
export type PromptSkill = Pick<SkillCommand, "name" | "hint" | "aliases">;

const LIST_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"]);

/**
 * The project's skills for the agent a button runs on: its model's, else the one new threads start with, each by its name
 * alone as the prompt saves it. An agent with no call for skills lists them too; the button asks it for them by name.
 */
export function usePromptSkills(projectId: string, choice: ThreadChoice | undefined): { skills: PromptSkill[]; onSkillsWanted: () => void } {
  const defaultAgent = useDefaultAgent();
  const { commands, onCommandsWanted } = useSkillCommands(projectScope(projectId), choice?.agent ?? defaultAgent, choice?.claudeAccountId, { byName: true });
  return { skills: commands, onSkillsWanted: onCommandsWanted };
}

/**
 * The Prompt field. A word starting `/` or `$` lists the skills to call, as `@` lists models in a task's comments, and
 * a pick writes `/name` whatever the agent: the button is written the agent's way when it runs.
 */
export function PromptField({
  value,
  onChange,
  skills,
  onSkillsWanted,
  disabled,
}: {
  value: string;
  onChange: (prompt: string) => void;
  skills: readonly PromptSkill[];
  onSkillsWanted: () => void;
  disabled: boolean;
}) {
  const id = useId();
  const editor = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const word = dismissed ? null : commandWordAt(value, caret);
  useCommandWord(word, onSkillsWanted, null);
  const matches = word ? rankCommands(skills, word.query).slice(0, 8) : [];
  const active = Math.min(selected, matches.length - 1);
  const choose = (skill: PromptSkill) => {
    if (!word) return;
    const next = insertSkill(value, word, caret, { prefix: "/", name: skill.name });
    onChange(next.text);
    setCaret(next.caret);
    setDismissed(true);
    requestAnimationFrame(() => {
      editor.current?.focus();
      editor.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!matches.length || !LIST_KEYS.has(event.key) || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    // Escape closes the list, not the dialog.
    event.stopPropagation();
    if (event.key === "Escape") setDismissed(true);
    else if (event.key === "ArrowDown") setSelected((active + 1) % matches.length);
    else if (event.key === "ArrowUp") setSelected((active + matches.length - 1) % matches.length);
    else choose(matches[active]!);
  };
  return (
    <div className="grid min-w-0 gap-1 mb-3">
      <label htmlFor={id} className="text-sm text-ink-3">
        Prompt
      </label>
      <Textarea
        ref={editor}
        id={id}
        rows={4}
        placeholder="Review this task's changes and list any risks."
        value={value}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        aria-autocomplete="list"
        aria-controls={matches.length ? `${id}-skills` : undefined}
        aria-activedescendant={matches.length ? `${id}-skill-${active}` : undefined}
        onChange={(event) => {
          onChange(event.target.value);
          setCaret(event.target.selectionStart);
          setSelected(0);
          setDismissed(false);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      {matches.length ? (
        <div className="typed-options task-button-skills" role="listbox" id={`${id}-skills`} aria-label="Add a skill">
          {matches.map((skill, index) => (
            <button
              key={skill.name}
              type="button"
              role="option"
              id={`${id}-skill-${index}`}
              aria-selected={index === active}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(skill)}
            >
              <span>/{skill.name}</span>
              <span>{skill.hint}</span>
            </button>
          ))}
        </div>
      ) : null}
      <span id={`${id}-hint`} className="text-xs text-ink-4">
        Type / to add a skill.
      </span>
    </div>
  );
}
