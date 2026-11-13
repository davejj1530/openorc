import type { CSSProperties } from "react";
import type { HarnessId } from "@openorc/protocol";
import type { ThemePreset } from "@openorc/client/theme";
import type { OnboardingStep } from "../lib/onboarding";
import { Check, FolderGit2 } from "./icons";
import { WorkspaceAppearancePreview } from "./WorkspaceAppearancePreview";
import { HarnessLogo } from "./HarnessLogo";
import { OpenOrcMark } from "./OpenOrcMark";
import { OnboardingMascot, type OnboardingMascotMood } from "./OnboardingMascot";
import ribbons from "../assets/onboarding/ribbons.webp";
import flower from "../assets/onboarding/flower.webp";
import shapes from "../assets/onboarding/shapes.webp";
import "../styles/onboarding-scene.css";

interface OnboardingSceneProps {
  step: OnboardingStep;
  mood: OnboardingMascotMood;
  reactionKey: string;
  agents: readonly HarnessId[];
  projectName?: string;
  colors: CSSProperties;
  preset: ThemePreset;
  mode: "light" | "dark";
}

function SceneMessage({ step, agents, projectName }: Pick<OnboardingSceneProps, "step" | "agents" | "projectName">) {
  if (step === "project" || step === "done")
    return (
      <div className="onboarding-scene-project" data-plane>
        <span className="onboarding-scene-project-icon">{step === "done" ? <Check size={28} /> : <FolderGit2 size={28} />}</span>
        <span className="onboarding-scene-project-name">{projectName ?? "Your next project"}</span>
        <span className="onboarding-scene-project-detail">{step === "done" ? "Ready for your first thread" : "A place for work to come together"}</span>
        <div className="onboarding-scene-project-lines">
          <i />
          <i />
          <i />
        </div>
      </div>
    );
  return (
    <div className="onboarding-scene-agents" data-plane>
      <span className="onboarding-scene-prompt">
        Your agents.
        <br />
        One workspace.
      </span>
      <div className="onboarding-scene-providers">
        {agents.slice(0, 3).map((id) => (
          <span key={id}>
            <HarnessLogo id={id} size={20} />
          </span>
        ))}
        <span className="onboarding-scene-provider-home">
          <OpenOrcMark size={20} />
        </span>
      </div>
    </div>
  );
}

/** Decorative companions to the real controls; never an additional source of setup state. */
export function OnboardingScene({ step, mood, reactionKey, agents, projectName, colors, mode, preset }: OnboardingSceneProps) {
  return (
    <div className="onboarding-scene" data-step={step} data-mode={mode} aria-hidden="true">
      <div className="onboarding-scene-art">
        <div className="onboarding-art-tile onboarding-art-ribbons">
          <img src={ribbons} alt="" width={640} height={640} draggable={false} />
        </div>
        <div className="onboarding-art-tile onboarding-art-flower">
          <img src={flower} alt="" width={640} height={640} draggable={false} />
        </div>
        <div className="onboarding-art-tile onboarding-art-shapes">
          <img src={shapes} alt="" width={640} height={640} draggable={false} />
        </div>
        <span className="onboarding-art-square" />
        <span className="onboarding-art-circle" />
      </div>
      <div className="onboarding-scene-content" style={colors} data-theme={mode}>
        <div className="onboarding-scene-message" key={step}>
          {step === "theme" ? <WorkspaceAppearancePreview colors={colors} mode={mode} preset={preset} /> : <SceneMessage step={step} agents={agents} projectName={projectName} />}
        </div>
        <div className="onboarding-scene-mascot">
          <OnboardingMascot mood={mood} reactionKey={reactionKey} />
        </div>
      </div>
    </div>
  );
}
