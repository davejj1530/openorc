import { Button } from "./ui";

const starters = [
  { label: "Explore this project", prompt: "Walk me through this project. Explain how it is organized and where the main features live." },
  { label: "Plan a change", prompt: "Help me plan a change to this project. Let's start by discussing what I want to build." },
  { label: "Review my changes", prompt: "Review the current uncommitted changes. Look for bugs, regressions, and anything that needs attention." },
];

/** Starter actions prepare a draft; sending remains an explicit choice. */
export function NewThreadStarters({ onStart, disabled }: { onStart: (prompt: string) => void; disabled: boolean }) {
  return (
    <div className="thread-starters" role="group" aria-label="Suggested prompts">
      {starters.map(({ label, prompt }) => (
        <Button key={label} variant="ghost" size="sm" disabled={disabled} onClick={() => onStart(prompt)}>
          {label}
        </Button>
      ))}
    </div>
  );
}
