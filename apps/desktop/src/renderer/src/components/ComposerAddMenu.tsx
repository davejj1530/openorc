import { Menu } from "@base-ui/react/menu";
import { Fragment, useRef, useState, type ComponentType, type RefObject } from "react";
import { useComposerControl } from "./composer-read-only";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import type { ListKind } from "./composer-commands";
import type { ComposerLists } from "./ComposerInput";
import { BookText, ChevronRight, FileCode2, Image, Orcling, Plug, Plus, Slash, Upload } from "./icons";
import { menuItem, menuPopup, menuSeparator } from "./menu";
import { useHostedControlReason } from "./HostedConversationBoundary";
import { HostedMenuReason } from "./HostedMenuReason";

/** The system's file chooser, for any file or only pictures. */
function chooseFiles(add: (files: File[]) => void, accept?: string): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  if (accept) input.accept = accept;
  input.onchange = () => add(Array.from(input.files ?? []));
  input.click();
}

interface ListRow {
  kind: ListKind;
  label: string;
  icon: ComponentType<{ size?: number }>;
  /** Why it cannot be opened now, said on demand. */
  blocked?: string | undefined;
}

/** What this message can name, grouped as the menu draws them: who and what is in the project, then what to run. */
export interface AddOffers {
  orclings: boolean;
  files: boolean;
  connectors: boolean;
  skills: boolean;
  commands: boolean;
  /** Commands start a message, so with words written they wait. */
  written: boolean;
}

function listGroups(offers: AddOffers): ListRow[][] {
  const named: ListRow[] = [
    ...(offers.orclings ? [{ kind: "orcling" as const, label: "Orcling", icon: Orcling }] : []),
    ...(offers.files ? [{ kind: "file" as const, label: "File from the project", icon: FileCode2 }] : []),
    ...(offers.connectors ? [{ kind: "connector" as const, label: "Connector", icon: Plug }] : []),
  ];
  const run: ListRow[] = [
    ...(offers.skills ? [{ kind: "skill" as const, label: "Skill", icon: BookText }] : []),
    ...(offers.commands ? [{ kind: "command" as const, label: "Command", icon: Slash, blocked: offers.written ? "Commands start a message." : undefined }] : []),
  ];
  return [named, run].filter((group) => group.length > 0);
}

/**
 * The plus: add to this message. Files and photos first, then everything `@` and `/` can name, each opening that list
 * at the caret as typing would. It is how someone who has never typed `@` finds mentions.
 */
export function ComposerAddMenu({
  onFiles,
  attachmentsBlocked,
  offers,
  lists,
}: {
  onFiles: (files: File[]) => void;
  attachmentsBlocked?: string | null | undefined;
  offers: AddOffers;
  lists: RefObject<ComposerLists | null>;
}) {
  const control = useComposerControl(false, "Add to this message");
  const fileReason = useHostedControlReason("fileBrowser");
  const [open, setOpen] = useState(false);
  const groups = listGroups(offers);
  // A list opens once the menu has gone, so the focus it takes into the message is not taken back by the menu closing.
  const pending = useRef<ListKind | null>(null);
  const settle = (open: boolean) => {
    const kind = pending.current;
    pending.current = null;
    if (!open && kind) lists.current?.open(kind);
  };
  return (
    <Menu.Root open={open && !control.disabled} onOpenChange={setOpen} onOpenChangeComplete={settle}>
      <Menu.Trigger disabled={control.disabled} aria-label="Add to this message" data-tip={control.reason} className="composer-icon-button composer-attach">
        <Plus size={16} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner side="top" align="start" sideOffset={6} collisionPadding={8}>
          <Menu.Popup ref={floatingGround} className={`${menuPopup} composer-add-menu`}>
            <Menu.Item className={menuItem} disabled={Boolean(attachmentsBlocked)} data-tip={attachmentsBlocked ?? undefined} onClick={() => chooseFiles(onFiles)}>
              <Upload size={15} />
              Files…
            </Menu.Item>
            <Menu.Item className={menuItem} disabled={Boolean(attachmentsBlocked)} data-tip={attachmentsBlocked ?? undefined} onClick={() => chooseFiles(onFiles, "image/*")}>
              <Image size={15} />
              Photos…
            </Menu.Item>
            {groups.map((group, index) => (
              <Fragment key={index}>
                <Menu.Separator className={menuSeparator} />
                {group.map((row) =>
                  row.kind === "file" && fileReason ? (
                    <HostedMenuReason key={row.kind} parts={Menu} reason={fileReason}>
                      <row.icon size={15} />
                      {row.label}
                      <ChevronRight size={14} className="composer-add-menu-end" />
                    </HostedMenuReason>
                  ) : (
                    <Menu.Item
                      key={row.kind}
                      className={menuItem}
                      disabled={Boolean(row.blocked)}
                      data-tip={row.blocked}
                      onClick={() => {
                        pending.current = row.kind;
                      }}
                    >
                      <row.icon size={15} />
                      {row.label}
                      <ChevronRight size={14} className="composer-add-menu-end" />
                    </Menu.Item>
                  ),
                )}
              </Fragment>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
