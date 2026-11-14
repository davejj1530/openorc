import { useEffect, useRef, useState } from "react";
import { Menu } from "@base-ui/react/menu";
import type { OrganizationPerson, OrganizationRole } from "@openorc/protocol";
import { AccountFace } from "../components/AccountFace";
import { Check, ChevronDown, MoreHorizontal, X } from "../components/icons";
import { Button, IconButton } from "../components/ui";
import { menuItem, menuItemDanger, menuPopup } from "../components/menu";
import { CoversPreview } from "../lib/browser-preview";
import { useRpcMutation } from "../lib/client";
import { floatingGround } from "../lib/use-anchor-ground";

const roleName = { admin: "Admin", member: "Member" };
const roles: OrganizationRole[] = ["member", "admin"];
export function OrganizationPeopleRow({
  person,
  spaceId,
  self,
  editable,
  onRemove,
  onChanged,
}: {
  person: OrganizationPerson;
  spaceId: string;
  self: boolean;
  editable: boolean;
  onRemove(person: OrganizationPerson, trigger: HTMLButtonElement | null): void;
  onChanged(): Promise<void>;
}) {
  const [readError, setReadError] = useState<string | null>(null);
  useEffect(() => setReadError(null), [person]);
  const role = useRpcMutation("organization.member.setRole");
  return (
    <div>
      <div className="people-grid people-row" role="row">
        <div className="people-name" role="cell">
          <AccountFace name={person.name} image={person.image} />
          <div className="min-w-0">
            <span>
              {person.name}
              {self ? <span className="people-you">You</span> : null}
            </span>
            <span className="organization-small">{person.email}</span>
          </div>
        </div>
        <span className="people-plan" role="cell">
          {person.plan === "pro" ? "Pro" : "Free"}
        </span>
        <div className="people-role" role="cell">
          {editable ? (
            <RolePicker
              person={person}
              pending={role.isPending}
              onRole={(next) =>
                role.mutate(
                  { spaceId, memberId: person.memberId, role: next },
                  {
                    onSuccess: () => {
                      void onChanged().then(
                        () => setReadError(null),
                        (error: unknown) => setReadError(error instanceof Error ? error.message : "OpenOrc Cloud can't be reached."),
                      );
                    },
                  },
                )
              }
            />
          ) : (
            roleName[person.role]
          )}
        </div>
        <div role="cell">{!self && editable ? <PersonMore person={person} onRemove={onRemove} /> : null}</div>
      </div>
      {readError ? (
        <p role="alert" className="organization-error people-row-error">
          Role changed. {readError}
        </p>
      ) : null}
      {role.error ? (
        <p role="alert" className="organization-error people-row-error">
          {role.error.message}
        </p>
      ) : null}
    </div>
  );
}

function RolePicker({ person, pending, onRole }: { person: OrganizationPerson; pending: boolean; onRole(role: OrganizationRole): void }) {
  return (
    <Menu.Root>
      <Menu.Trigger render={<Button size="sm" variant="ghost" />} aria-label={`Role for ${person.name}`} disabled={pending}>
        {roleName[person.role]}
        <ChevronDown size={12} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner align="start" sideOffset={4} collisionPadding={8} className="z-40">
          <Menu.Popup ref={floatingGround} className={`${menuPopup} people-role-menu`}>
            {roles.map((role) => (
              <Menu.Item
                key={role}
                className={menuItem}
                onClick={() => {
                  if (role !== person.role) onRole(role);
                }}
              >
                {role === person.role ? <Check size={13} /> : <span className="people-check-space" />}
                {roleName[role]}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function PersonMore({ person, onRemove }: { person: OrganizationPerson; onRemove(person: OrganizationPerson, trigger: HTMLButtonElement | null): void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Menu.Root>
      <Menu.Trigger ref={trigger} render={<IconButton aria-label={`More for ${person.name}`} size="xs" />}>
        <MoreHorizontal size={15} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner align="end" sideOffset={4} collisionPadding={8} className="z-40">
          <Menu.Popup ref={floatingGround} className={`${menuPopup} people-member-menu`}>
            <Menu.Item className={menuItemDanger} onClick={() => onRemove(person, trigger.current)}>
              <X size={14} />
              Remove member…
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
