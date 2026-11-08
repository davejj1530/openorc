import { Menu } from "@base-ui/react/menu";
import { useRef } from "react";
import type { AgentSkill } from "@openorc/protocol";
import { ConnectorLogo } from "../components/ConnectorLogo";
import { Image, Text } from "../components/icons";
import { menuItem, menuPopup } from "../components/menu";
import { CoversPreview } from "../lib/browser-preview";
import { useRpcMutation } from "../lib/client";
import { floatingGround } from "../lib/use-anchor-ground";
import { patchSkill } from "./settings-skills-data";
import { skillRef, skillTitle, type SkillsPlace } from "./settings-skills-model";

const logoSizes = { row: 18, head: 28 };
const IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/svg+xml";
const MAX_IMAGE_BYTES = 1024 * 1024;

/** A skill's image on the light badge connectors use, or the first letter of its name. */
export function SkillBadge({ skill, size }: { skill: AgentSkill; size: keyof typeof logoSizes }) {
  return (
    <span className="logo-badge skill-badge" data-size={size}>
      <ConnectorLogo title={skillTitle(skill)} logo={skill.icon ?? null} size={logoSizes[size]} />
    </span>
  );
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("The image could not be read."));
    reader.readAsDataURL(file);
  });
}

/** The detail's large image. A skill the user may change opens a menu on it to choose an image or go back to the letter. */
export function SkillImage({ skill, place, onProblem }: { skill: AgentSkill; place: SkillsPlace; onProblem: (problem: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const setIcon = useRpcMutation("skills.setIcon");
  if (!skill.editable) return <SkillBadge skill={skill} size="head" />;
  const apply = (image: string | null) => {
    onProblem(null);
    setIcon.mutate({ ...skillRef(place, skill), image }, { onSuccess: ({ icon }) => patchSkill(place, skill.path, { icon: icon ?? undefined }), onError: (error) => onProblem(error.message) });
  };
  const choose = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) return onProblem("Choose an image under 1 MB.");
    try {
      apply(await readDataUrl(file));
    } catch (error) {
      onProblem(error instanceof Error ? error.message : "The image could not be read.");
    }
  };
  return (
    <>
      <Menu.Root>
        <Menu.Trigger className="skill-badge-button" aria-label={`Image for ${skillTitle(skill)}`} disabled={setIcon.isPending}>
          <SkillBadge skill={skill} size="head" />
        </Menu.Trigger>
        <Menu.Portal>
          <CoversPreview />
          <Menu.Positioner sideOffset={6} align="start" className="z-40" collisionPadding={8}>
            <Menu.Popup ref={floatingGround} className={menuPopup}>
              <Menu.Item className={menuItem} onClick={() => input.current?.click()}>
                <Image size={14} />
                Choose image…
              </Menu.Item>
              {skill.icon ? (
                <Menu.Item className={menuItem} onClick={() => apply(null)}>
                  <Text size={14} />
                  Use a letter
                </Menu.Item>
              ) : null}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <input
        ref={input}
        type="file"
        accept={IMAGE_TYPES}
        hidden
        aria-label={`Image file for ${skillTitle(skill)}`}
        onChange={(event) => {
          void choose(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
    </>
  );
}
