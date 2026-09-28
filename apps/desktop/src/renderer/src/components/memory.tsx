import type { MemoryType } from "@openorc/protocol";
import { BookText, Check, FileCode2, GitBranch, Lightbulb, ListChecks, Settings2, SquareStack, Terminal } from "./icons";
import type { ReactNode } from "react";

export const memoryTypeLabel: Record<MemoryType, string> = {
  decision: "Decision",
  lesson: "Lesson",
  command: "Command",
  env_quirk: "Env quirk",
  convention: "Convention",
  preference: "Preference",
  spec: "Spec",
  ownership: "Ownership",
};

export const memoryTypeOrder: MemoryType[] = ["decision", "lesson", "command", "env_quirk", "convention", "preference", "spec", "ownership"];

export function MemoryTypeIcon({ type, size = 14 }: { type: MemoryType; size?: number }): ReactNode {
  const c = "text-ink-3 shrink-0";
  switch (type) {
    case "decision":
      return <Check size={size} className={c} />;
    case "lesson":
      return <Lightbulb size={size} className={c} />;
    case "command":
      return <Terminal size={size} className={c} />;
    case "env_quirk":
      return <Settings2 size={size} className={c} />;
    case "convention":
      return <ListChecks size={size} className={c} />;
    case "preference":
      return <SquareStack size={size} className={c} />;
    case "spec":
      return <BookText size={size} className={c} />;
    case "ownership":
      return <FileCode2 size={size} className={c} />;
  }
}

export { GitBranch };
