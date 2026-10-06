import { useId, useState } from "react";
import { MAX_TEAM_DEPTH, MAX_TEAM_MEMBERS, harnessInfo, harnessLoggedIn, isHarnessId, teamDiscussion, type TeamDraft, type TeamMember, type TeamMemberAvatarChoice } from "@openorc/protocol";
import { Plus, Trash2, Workflow } from "../components/icons";
import { MemberAvatar, TEAM_AVATARS } from "../components/MemberAvatar";
import { defaultChoice, ModelPicker } from "../components/ModelPicker";
import { orclingById, useOrclings } from "../lib/orclings";
import { Badge, Button, Dialog, IconButton, Input, Select, Switch, Textarea, TextButton, Tooltip } from "../components/ui";
import { addTeamMember, promoteTeamLead, removeTeamMember, updateTeamMember } from "../lib/team-editor-draft";
import { useRpc, useRpcMutation } from "../lib/query";

/** How much the team talks on its own: every ambient read is a model turn, so the defaults stay small. */
function DiscussionEditor({ draft, onChange }: { draft: TeamDraft; onChange: (discussion: NonNullable<TeamDraft["discussion"]>) => void }) {
  const discussion = teamDiscussion(draft);
  const follows = (key: string) => !discussion.mentionOnly.includes(key);
  return (
    <section aria-labelledby="team-discussion-heading" className="mt-7">
      <h2 id="team-discussion-heading" className="text-base font-medium">
        Discussion
      </h2>
      <p className="text-sm text-ink-3 mt-1 mb-3">
        By default, members work only when addressed and catch up on the conversation on their next turn. Automatic reads use extra model turns; enable them only for members whose input you need.
      </p>
      <div className="orchestration-fields">
        <label className="grid gap-1.5 text-sm text-ink-3">
          Reads per message
          <Select aria-label="Reads per message" value={discussion.ambientRounds} onChange={(event) => onChange({ ...discussion, ambientRounds: Number(event.target.value) })}>
            <option value={0}>Off (recommended)</option>
            <option value={1}>One</option>
            <option value={2}>Two</option>
            <option value={3}>Three</option>
          </Select>
        </label>
        <label className="grid gap-1.5 text-sm text-ink-3">
          Follow-ups after colleagues
          <Select aria-label="Follow-ups after colleagues" value={discussion.peerFollowUps} onChange={(event) => onChange({ ...discussion, peerFollowUps: Number(event.target.value) })}>
            <option value={0}>None</option>
            <option value={1}>One</option>
            <option value={2}>Two</option>
          </Select>
        </label>
      </div>
      <ul className="mt-3 grid gap-2">
        {draft.members.map((member) => (
          <li key={member.key}>
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <Switch
                checked={follows(member.key)}
                onChange={(event) =>
                  onChange({ ...discussion, mentionOnly: event.target.checked ? discussion.mentionOnly.filter((key) => key !== member.key) : [...discussion.mentionOnly, member.key] })
                }
              />
              {member.name || member.key} can read automatically
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MemberEditor({
  member,
  members,
  index,
  teamId,
  avatar,
  avatarReady,
  avatarLoading,
  avatarError,
  unavailable,
  fastSupported,
  fastHint,
  onChange,
  onLead,
  onRemove,
}: {
  member: TeamMember;
  members: TeamMember[];
  index: number;
  teamId: string | null;
  avatar: TeamMemberAvatarChoice | null;
  avatarReady: boolean;
  avatarLoading: boolean;
  avatarError: string | null;
  unavailable: string | null;
  fastSupported: boolean;
  fastHint: string | null;
  onChange: (patch: Partial<TeamMember>) => void;
  onLead: () => void;
  onRemove: () => void;
}) {
  const id = useId();
  const lead = member.managerKey === null;
  // An Orcling in the seat brings its own name and face; they change only where the Orcling is edited.
  const seated = orclingById(useOrclings(), member.orclingId);
  return (
    <div className="orchestration-card orchestration-member">
      <div className="flex items-center gap-3 mb-3 min-w-0">
        <MemberAvatar avatar={avatar} orcling={seated} fallbackIndex={index} size="lg" />
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium truncate">{member.name || `Member ${index + 1}`}</span>
          {lead ? (
            <Badge>Lead</Badge>
          ) : (
            <TextButton type="button" underline tone="muted" className="text-xs" onClick={onLead}>
              Make lead
            </TextButton>
          )}
        </div>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          disabled={lead && members.length > 1}
          title={lead && members.length > 1 ? "Make another member the lead before removing this one" : undefined}
          aria-label={`Remove ${member.name || `member ${index + 1}`}`}
          onClick={onRemove}
        >
          <Trash2 size={13} />
        </Button>
      </div>
      {seated ? null : (
        <AvatarEditor
          memberKey={member.key}
          memberName={member.name || `Member ${index + 1}`}
          teamId={teamId}
          avatar={avatar}
          fallbackIndex={index}
          ready={avatarReady}
          loading={avatarLoading}
          loadError={avatarError}
        />
      )}
      <div className="orchestration-fields">
        <label className="grid gap-1.5 text-sm text-ink-3" title={seated ? `${seated.name} keeps its own name. Edit ${seated.name} to rename it.` : undefined}>
          Member name
          <Input maxLength={80} value={seated?.name ?? member.name} disabled={Boolean(seated)} onChange={(event) => onChange({ name: event.target.value })} />
        </label>
        <label className="grid gap-1.5 text-sm text-ink-3">
          Reports to
          <Select className="h-8" value={member.managerKey ?? ""} disabled={lead} onChange={(event) => onChange({ managerKey: event.target.value })}>
            {lead ? <option value="">Team lead</option> : null}
            {members
              .filter((item) => item.key !== member.key)
              .map((item) => (
                <option key={item.key} value={item.key}>
                  {item.name || "Unnamed member"}
                </option>
              ))}
          </Select>
        </label>
      </div>
      <MemberModelRow id={`${id}-model`} member={member} fastSupported={fastSupported} fastHint={fastHint} onChange={onChange} />
      {unavailable ? <p className="text-sm text-warn mt-1">{unavailable}</p> : null}
      <label className="mt-3 grid gap-1.5 text-sm text-ink-3">
        Responsibility
        <Textarea rows={2} maxLength={8000} placeholder="What should this member own?" value={member.responsibility} onChange={(event) => onChange({ responsibility: event.target.value })} />
      </label>
    </div>
  );
}

function AvatarEditor({
  memberKey,
  memberName,
  teamId,
  avatar,
  fallbackIndex,
  ready,
  loading,
  loadError,
}: {
  memberKey: string;
  memberName: string;
  teamId: string | null;
  avatar: TeamMemberAvatarChoice | null;
  fallbackIndex: number;
  ready: boolean;
  loading: boolean;
  loadError: string | null;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const setAvatar = useRpcMutation("orchestration.avatars.set");
  const resetAvatar = useRpcMutation("orchestration.avatars.reset");
  const pending = setAvatar.isPending || resetAvatar.isPending;
  const canCustomize = Boolean(teamId && ready && !loadError);
  const defaultIndex = avatar?.kind === "default" ? avatar.index : fallbackIndex;
  const defaultName = TEAM_AVATARS[((defaultIndex % TEAM_AVATARS.length) + TEAM_AVATARS.length) % TEAM_AVATARS.length]?.name ?? "Default";

  const setChoice = async (choice: TeamMemberAvatarChoice) => {
    if (!teamId) return;
    setLocalError(null);
    try {
      await setAvatar.mutateAsync({ teamId, memberKey, avatar: choice });
      setPickerOpen(false);
    } catch {
      /* The mutation error is rendered beside the controls. */
    }
  };

  const chooseImage = () => {
    if (!teamId) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const path = window.openorc.filePath(file);
      if (!path) {
        setLocalError("That image could not be opened from this device.");
        return;
      }
      void setChoice({ kind: "custom", path });
    };
    input.click();
  };

  const reset = async () => {
    if (!teamId) return;
    setLocalError(null);
    try {
      await resetAvatar.mutateAsync({ teamId, memberKey });
    } catch {
      /* The mutation error is rendered beside the controls. */
    }
  };

  let unavailable: string | null = null;
  if (!teamId) unavailable = "Save the team to customize pictures.";
  else if (loading) unavailable = "Loading profile picture…";
  else if (!ready && !loadError) unavailable = "Save team changes before customizing this member.";
  const error = localError ?? setAvatar.error?.message ?? resetAvatar.error?.message ?? loadError;
  return (
    <div className="orchestration-avatar-editor">
      <div className="orchestration-avatar-copy">
        <span className="text-sm text-ink-3">Profile picture</span>
        <span className="text-xs text-ink-4">{avatar?.kind === "custom" ? "Custom image" : defaultName}</span>
      </div>
      <div className="orchestration-avatar-actions">
        <Button size="sm" variant="ghost" disabled={!canCustomize || pending} onClick={() => setPickerOpen(true)}>
          Choose default
        </Button>
        <Button size="sm" variant="ghost" disabled={!canCustomize || pending} onClick={chooseImage}>
          Choose image
        </Button>
        <Button size="sm" variant="ghost" disabled={!canCustomize || pending || avatar?.kind !== "custom"} onClick={() => void reset()}>
          Reset to default
        </Button>
      </div>
      {unavailable ? <p className="orchestration-avatar-message">{unavailable}</p> : null}
      {error ? (
        <p className="orchestration-avatar-message text-bad" role="alert">
          {error}
        </p>
      ) : null}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen} title={`Profile picture for ${memberName}`} width={360}>
        <p className="text-sm text-ink-3 mb-3">Choose a bundled profile picture. The selection stays with this member across team versions.</p>
        <div className="orchestration-avatar-grid" role="radiogroup" aria-label={`Default profile picture for ${memberName}`}>
          {TEAM_AVATARS.map((option, index) => (
            <button
              key={option.name}
              type="button"
              role="radio"
              aria-checked={avatar?.kind === "default" && avatar.index === index}
              aria-label={option.name}
              title={option.name}
              className="orchestration-avatar-option"
              data-selected={(avatar?.kind === "default" && avatar.index === index) || undefined}
              disabled={pending}
              onClick={() => void setChoice({ kind: "default", index })}
            >
              <MemberAvatar avatar={{ kind: "default", index }} size="sm" />
            </button>
          ))}
        </div>
      </Dialog>
    </div>
  );
}

/** Traverse with a guard so invalid drafts can always be displayed and repaired. */
function Hierarchy({ members }: { members: TeamMember[] }) {
  const visited = new Set<string>();
  const rows: { member: TeamMember; depth: number }[] = [];
  const visit = (member: TeamMember, depth: number) => {
    if (visited.has(member.key)) return;
    visited.add(member.key);
    rows.push({ member, depth });
    for (const child of members.filter((item) => item.managerKey === member.key)) visit(child, depth + 1);
  };
  for (const root of members.filter((member) => member.managerKey === null)) visit(root, 0);
  for (const disconnected of members) if (!visited.has(disconnected.key)) visit(disconnected, 0);
  return (
    <ol aria-label="Team hierarchy" className="orchestration-tree">
      {rows.map(({ member, depth }) => (
        <li key={member.key} style={{ paddingLeft: `${Math.min(depth, 3) * 20}px` }}>
          <Workflow size={13} className="shrink-0 text-ink-3" />
          <span className="truncate">{member.name || "Unnamed member"}</span>
          <span className="ml-auto text-xs text-ink-3 shrink-0">{member.managerKey === null ? "Lead" : `Level ${depth + 1}`}</span>
        </li>
      ))}
    </ol>
  );
}

export function TeamMembers({ draft, teamId, onChange }: { draft: TeamDraft; teamId: string | null; onChange: (change: Partial<TeamDraft>) => void }) {
  const models = useRpc("agents.models", {}, { staleTime: 5 * 60_000 });
  const info = useRpc("system.info", {});
  const avatars = useRpc("orchestration.avatars.list", { teamId: teamId ?? "" }, { enabled: Boolean(teamId) });
  const addMember = () => {
    const change = addTeamMember(draft, defaultChoice(models.data ?? [], null), crypto.randomUUID());
    if (change) onChange(change);
  };
  return (
    <>
      {draft.members.length > 0 ? (
        <section aria-labelledby="team-hierarchy-heading" className="mb-7">
          <h2 id="team-hierarchy-heading" className="text-base font-medium">
            Hierarchy
          </h2>
          <p className="text-sm text-ink-3 mt-1 mb-3">One lead and up to {MAX_TEAM_DEPTH} levels. Responsibilities guide how the lead delegates.</p>
          <Hierarchy members={draft.members} />
        </section>
      ) : null}
      <section aria-labelledby="team-members-heading">
        <div className="flex items-center justify-between gap-2 mb-1">
          <h2 id="team-members-heading" className="text-base font-medium">
            Members{" "}
            <span className="font-normal text-ink-3">
              {draft.members.length} / {MAX_TEAM_MEMBERS}
            </span>
          </h2>
          {draft.members.length === 0 ? (
            <Button size="sm" disabled={draft.members.length >= MAX_TEAM_MEMBERS} onClick={addMember}>
              <Plus size={13} /> Add member
            </Button>
          ) : (
            <Tooltip label="Add member">
              <IconButton aria-label="Add member" size="sm" disabled={draft.members.length >= MAX_TEAM_MEMBERS} onClick={addMember}>
                <Plus size={14} />
              </IconButton>
            </Tooltip>
          )}
        </div>
        {draft.members.length === 0 ? <p className="orchestration-slot text-sm text-ink-3">Add the lead first, then the members they can delegate to.</p> : null}
        {models.error ? (
          <div className="text-sm text-bad py-2">
            Models couldn’t load.{" "}
            <TextButton type="button" underline onClick={() => void models.refetch()}>
              Retry
            </TextButton>
          </div>
        ) : null}
        {draft.members.map((member, index) => {
          const model = models.data?.find((option) => option.agent === member.settings.agent && option.id === member.settings.model);
          const loggedIn = info.data ? harnessLoggedIn(harnessInfo(info.data, member.settings.agent)) : undefined;
          const avatar = avatars.data?.find((item) => item.memberKey === member.key);
          let unavailable: string | null = model?.unavailable ?? null;
          if (unavailable === null && info.data && !loggedIn) unavailable = "Log in to this provider to use this member.";
          else if (unavailable === null && !models.isLoading && models.data && !model) unavailable = "Choose a model from the current catalog.";
          return (
            <MemberEditor
              key={member.key}
              member={member}
              members={draft.members}
              index={index}
              teamId={teamId}
              avatar={avatar?.avatar ?? null}
              avatarReady={Boolean(avatar)}
              avatarLoading={avatars.isLoading}
              avatarError={avatars.error?.message ?? null}
              unavailable={unavailable}
              fastSupported={Boolean(model?.fastMode?.supported)}
              fastHint={model?.fastMode?.reason ?? null}
              onChange={(update) => onChange(updateTeamMember(draft, member.key, update))}
              onLead={() => onChange(promoteTeamLead(draft, member.key))}
              onRemove={() => onChange(removeTeamMember(draft, member.key))}
            />
          );
        })}
      </section>
      {draft.members.length > 0 ? <DiscussionEditor draft={draft} onChange={(discussion) => onChange({ discussion })} /> : null}
    </>
  );
}

/** The member's model and Fast mode. An Orcling sits with its own model, effort and Fast mode; they change only where the Orcling is edited. */
function MemberModelRow({
  id,
  member,
  fastSupported,
  fastHint,
  onChange,
}: {
  id: string;
  member: TeamMember;
  fastSupported: boolean;
  fastHint: string | null;
  onChange: (patch: Partial<TeamMember>) => void;
}) {
  return (
    <div className="mt-3 flex items-center gap-3 flex-wrap">
      <MemberModel id={id} member={member} onChange={onChange} />
      {member.orclingId ? null : (
        <label className="flex items-center gap-2 text-sm text-ink-2 mt-5" title={fastHint ?? (!fastSupported ? "Fast mode is unavailable for this model" : undefined)}>
          <Switch
            checked={member.settings.fastMode}
            disabled={!fastSupported && !member.settings.fastMode}
            onChange={(event) => onChange({ settings: { ...member.settings, fastMode: event.target.checked } })}
          />
          Fast mode
        </label>
      )}
    </div>
  );
}

/** The member's model, or an Orcling who takes the seat with its own model, instructions and memory. */
function MemberModel({ id, member, onChange }: { id: string; member: TeamMember; onChange: (patch: Partial<TeamMember>) => void }) {
  const orclings = useOrclings();
  return (
    <div>
      <span id={id} className="block text-sm text-ink-3 mb-1">
        Model and effort
      </span>
      <div aria-labelledby={id}>
        <ModelPicker
          value={member.settings.model ? member.settings : null}
          onChange={(choice) => {
            if (isHarnessId(choice.agent)) onChange({ settings: { agent: choice.agent, model: choice.model, effort: choice.effort, fastMode: Boolean(choice.fastMode) }, orclingId: null });
          }}
          orclings={{
            options: orclings,
            selectedId: member.orclingId ?? null,
            onSelect: (orcling) => onChange({ settings: { ...orcling.settings }, orclingId: orcling.id, name: orcling.name }),
          }}
        />
      </div>
    </div>
  );
}
