import { commandWordAt, insertSkill, rankCommands, skillNames, skillSegments, useCommandWord, type SkillCommand, type SkillListNotice, type SkillSegment } from "@openorc/client";
import type { AgentKind, FileScope } from "@openorc/protocol";
import { useMemo, useState } from "react";
import { useHostClient } from "../client";

export interface SkillPicker {
  /** The message in runs, those that name a skill marked, for the prompt to draw. */
  segments: SkillSegment[];
  /** The skills that answer the `/` or `$` word at the caret, best first; none while the caret is in no such word. */
  matches: SkillCommand[];
  /** Said in place of the rows while there are no skills to offer yet. */
  notice: SkillListNotice | null;
  /** Where the prompt puts its caret after a pick, until the person moves it. */
  selection: { start: number; end: number } | undefined;
  onSelectionChange: (caret: number) => void;
  pick: (skill: SkillCommand) => void;
}

/**
 * The skill picker of a composer whose conversation works in `scope`: what the `/` or `$` word at the caret matches,
 * and the message with the skill put in its place. The list, its ranking and the insertion are the desktop's.
 */
export function useSkillPicker({
  scope,
  agent,
  claudeAccountId,
  text,
  onText,
}: {
  scope: FileScope | null;
  agent: AgentKind | null | undefined;
  claudeAccountId: string | undefined;
  text: string;
  onText: (text: string) => void;
}): SkillPicker {
  const skills = useHostClient().useSkillCommands(scope, agent, claudeAccountId);
  const [caret, setCaret] = useState(text.length);
  const [selection, setSelection] = useState<{ start: number; end: number }>();
  const word = commandWordAt(text, caret);
  const notice = useCommandWord(word, skills.onCommandsWanted, skills.commandsNotice);
  const prefix = word?.prefix;
  const query = word?.query;
  // A slash opens the list for either agent; picking still writes the agent's own prefix.
  const matches = useMemo(
    () =>
      prefix === undefined || query === undefined
        ? []
        : rankCommands(
            skills.commands.filter((skill) => prefix === "/" || skill.prefix === prefix),
            query,
          ),
    [skills.commands, prefix, query],
  );
  const names = useMemo(() => skillNames(skills.commands), [skills.commands]);
  const marker = skills.commands[0]?.prefix ?? "/";
  const segments = useMemo(() => skillSegments(text, names, marker), [text, names, marker]);
  return {
    segments,
    matches,
    notice,
    selection,
    onSelectionChange: (at) => {
      setCaret(at);
      setSelection(undefined);
    },
    pick: (skill) => {
      if (!word) return;
      const next = insertSkill(text, word, caret, skill);
      onText(next.text);
      setCaret(next.caret);
      setSelection({ start: next.caret, end: next.caret });
    },
  };
}
