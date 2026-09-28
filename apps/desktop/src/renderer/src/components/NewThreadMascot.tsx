import { useEffect, useRef, useState } from "react";
import { RiveMascot } from "./RiveMascot";
import type { MascotReaction } from "./mascot-runtime";
import type { ModelChoice } from "./ModelPicker";
import "./NewThreadMascot.css";

export function NewThreadMascot({ choice, placement }: { choice: ModelChoice | null; placement?: "composer" | "hero" }) {
  const previousChoice = useRef(choice);
  const [reaction, setReaction] = useState<{ type: MascotReaction; key: number } | null>(null);
  useEffect(() => {
    const previous = previousChoice.current;
    previousChoice.current = choice;
    // Loading the initial model is not a user interaction.
    if (!previous || !choice) return;
    let type: MascotReaction | null = null;
    if (Boolean(previous.fastMode) !== Boolean(choice.fastMode)) type = choice.fastMode ? "FastOn" : "FastOff";
    else if (previous.effort !== choice.effort) type = "EffortChange";
    if (type) setReaction((current) => ({ type, key: (current?.key ?? 0) + 1 }));
  }, [choice]);
  return <RiveMascot className="new-thread-mascot" placement={placement} reaction={reaction?.type} reactionKey={reaction?.key} />;
}
