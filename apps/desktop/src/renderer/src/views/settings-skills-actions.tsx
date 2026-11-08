import { Menu } from "@base-ui/react/menu";
import { useState } from "react";
import type { AgentSkill } from "@openorc/protocol";
import { FolderOpen, MessageSquare, MoreHorizontal, Trash2 } from "../components/icons";
import { menuItem, menuItemDanger, menuPopup, menuSeparator } from "../components/menu";
import { Button, Dialog, IconButton } from "../components/ui";
import { CoversPreview } from "../lib/browser-preview";
import { useRpcMutation } from "../lib/client";
import { openNewThreadWith } from "../lib/new-thread-prefill";
import { floatingGround } from "../lib/use-anchor-ground";
import { dropSkill } from "./settings-skills-data";
import { skillRef, skillTitle, tryPrompt, type SkillsPlace } from "./settings-skills-model";

/** Moves a skill to the Trash once the user agrees. */
function RemoveSkillDialog({ skill, place, open, onOpenChange }: { skill: AgentSkill; place: SkillsPlace; open: boolean; onOpenChange: (open: boolean) => void }) {
  const remove = useRpcMutation("skills.remove");
  const confirm = () =>
    remove.mutate(skillRef(place, skill), {
      onSuccess: () => {
        onOpenChange(false);
        dropSkill(place, skill.path);
      },
    });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Remove ${skillTitle(skill)}?`}>
      <p className="text-base text-ink-2 mb-3">Its folder moves to the Trash, where you can restore it.</p>
      {remove.error ? (
        <p role="alert" className="text-sm text-bad mb-3">
          {remove.error.message}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="danger" disabled={remove.isPending} onClick={confirm}>
          Remove
        </Button>
      </div>
    </Dialog>
  );
}

/** The detail's ⋯ menu: try the skill in a new thread, show its folder, or remove a skill that is the user's. */
export function SkillActions({ skill, place }: { skill: AgentSkill; place: SkillsPlace }) {
  const [removing, setRemoving] = useState(false);
  const title = skillTitle(skill);
  return (
    <>
      <Menu.Root>
        <Menu.Trigger render={<IconButton aria-label={`More for ${title}`} />}>
          <MoreHorizontal size={16} />
        </Menu.Trigger>
        <Menu.Portal>
          <CoversPreview />
          <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
            <Menu.Popup ref={floatingGround} className={menuPopup}>
              <Menu.Item className={menuItem} onClick={() => void openNewThreadWith({ projectId: place.projectId, agent: place.agent, prompt: tryPrompt(place.agent, skill) })}>
                <MessageSquare size={14} />
                Try in a new thread
              </Menu.Item>
              {skill.path ? (
                <Menu.Item className={menuItem} onClick={() => window.openorc.revealFile(skill.path)}>
                  <FolderOpen size={14} />
                  Open folder
                </Menu.Item>
              ) : null}
              {skill.editable ? (
                <>
                  <Menu.Separator className={menuSeparator} />
                  <Menu.Item className={menuItemDanger} onClick={() => setRemoving(true)}>
                    <Trash2 size={14} />
                    Remove skill
                  </Menu.Item>
                </>
              ) : null}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {skill.editable ? <RemoveSkillDialog skill={skill} place={place} open={removing} onOpenChange={setRemoving} /> : null}
    </>
  );
}
