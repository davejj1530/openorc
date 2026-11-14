import { useRef, useState } from "react";
import type { OrganizationIdentity } from "@openorc/protocol";
import { OrganizationMark } from "../components/OrganizationMark";
import { Button, Dialog, Input } from "../components/ui";
import { useOrganizationSave } from "../lib/organization-save";
import { organizationLogo } from "../lib/organization-logo";

export interface OrganizationSaved {
  spaceId: string;
  logoError: string | null;
  pendingLogo: string | null;
}
interface Props {
  open: boolean;
  organization?: OrganizationIdentity;
  onOpenChange(open: boolean): void;
  onSaved(result: OrganizationSaved, signal: AbortSignal): void | Promise<void>;
}

export function OrganizationIdentityDialog(props: Props) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} title={props.organization ? "Edit organization" : "Create organization"} width={420}>
      <IdentityForm key={props.organization?.id ?? "create"} {...props} />
    </Dialog>
  );
}

function IdentityForm({ organization, onOpenChange, onSaved }: Props) {
  const [name, setName] = useState(organization?.name ?? "");
  const [logo, setLogo] = useState(organization?.logo ?? null);
  const [reading, setReading] = useState(false);
  const save = useOrganizationSave({ organization, name, logo, onSaved, close: () => onOpenChange(false) });
  const { pending, error, setError } = save;
  const disabled = pending || Boolean(save.saved);
  const pick = async (picked: File | undefined) => {
    if (!picked) return;
    setReading(true);
    setError(null);
    try {
      setLogo(await organizationLogo(picked));
    } catch (error) {
      setError(error instanceof Error ? error.message : "That picture couldn't be read. Pick another PNG, JPEG or WebP.");
    } finally {
      setReading(false);
    }
  };
  return (
    <form
      className="organization-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!reading) void save.submit();
      }}
    >
      <LogoField logo={logo} pending={disabled} reading={reading} pick={pick} remove={() => setLogo(null)} />
      <label className="organization-label">
        Name
        <Input
          variant="sheet"
          aria-label="Organization name"
          placeholder="Organization name"
          value={name}
          disabled={disabled}
          autoFocus
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          aria-invalid={Boolean(error)}
        />
      </label>
      {save.saved ? <p>{organization ? "Organization updated." : `You created ${name.trim()}.`}</p> : null}
      {error ? (
        <p className="organization-error" role="alert">
          {error}
        </p>
      ) : null}
      <IdentityActions name={name} logo={logo} organization={organization} saved={Boolean(save.saved)} pending={pending} reading={reading} close={() => onOpenChange(false)} />
    </form>
  );
}

function IdentityActions({
  name,
  logo,
  organization,
  saved,
  pending,
  reading,
  close,
}: {
  name: string;
  logo: string | null;
  organization?: OrganizationIdentity;
  saved: boolean;
  pending: boolean;
  reading: boolean;
  close(): void;
}) {
  let action = organization ? "Save changes" : "Create organization";
  if (saved) action = organization ? "Try again" : `Open ${name.trim()}`;
  let working = organization ? "Saving…" : "Creating…";
  if (saved) working = "Opening…";
  const unchanged = organization && name === organization.name && logo === organization.logo && !saved;
  return (
    <div className="organization-actions">
      <Button onClick={close}>{saved ? "Close" : "Cancel"}</Button>
      <Button type="submit" variant="primary" className="organization-save-action" disabled={!name.trim() || pending || reading || Boolean(unchanged)}>
        <span data-tip={action}>{pending ? working : action}</span>
      </Button>
    </div>
  );
}

function LogoField({ logo, pending, reading, pick, remove }: { logo: string | null; pending: boolean; reading: boolean; pick(file: File | undefined): Promise<void>; remove(): void }) {
  const file = useRef<HTMLInputElement>(null);
  const action = logo ? "Change logo" : "Add logo";
  return (
    <div className="organization-logo-field">
      <OrganizationMark logo={logo} size={48} />
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        aria-label="Organization logo"
        onChange={(event) => {
          void pick(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <Button size="sm" disabled={pending || reading} onClick={() => file.current?.click()}>
        {reading ? "Reading…" : action}
      </Button>
      {logo ? (
        <Button size="sm" variant="ghost" disabled={pending || reading} onClick={remove}>
          Remove
        </Button>
      ) : null}
    </div>
  );
}
