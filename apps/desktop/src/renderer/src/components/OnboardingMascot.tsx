import { RiveMascot } from "./RiveMascot";
import type { MascotReaction } from "./mascot-runtime";
import "../styles/onboarding-mascot.css";

export type OnboardingMascotMood = "curious" | "thinking" | "pleased" | "styling" | "reassuring" | "celebrating";

const reactions: Record<OnboardingMascotMood, MascotReaction | undefined> = {
  curious: undefined,
  thinking: "Thinking",
  pleased: "Happy",
  styling: "Happy",
  reassuring: "Working",
  celebrating: "Happy",
};

/** Uses the same themeable Rive character as the new-thread greeting. */
export function OnboardingMascot({ mood, reactionKey = "" }: { mood: OnboardingMascotMood; reactionKey?: string }) {
  return (
    <div className="onboarding-mascot" data-mood={mood} aria-hidden="true">
      <RiveMascot reaction={reactions[mood]} reactionKey={`${mood}:${reactionKey}`} />
    </div>
  );
}
