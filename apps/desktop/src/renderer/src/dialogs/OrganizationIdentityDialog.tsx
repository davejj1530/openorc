import { useRef, useState } from "react";
import type { OrganizationIdentity } from "@openorc/protocol";
import { OrganizationMark } from "../components/OrganizationMark";
import { Button, Dialog, Input } from "../components/ui";
import { useRpcMutation } from "../lib/client";
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
  onSaved(result: OrganizationSaved): void | Promise<void>;
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
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const submitting = useRef(false);
  const create = useRpcMutation("spaces.create");
  const update = useRpcMutation("organization.update");
  const pending = create.isPending || update.isPending;
  const action = organization ? "Save changes" : "Create organization";
  const working = organization ? "Saving…" : "Creating…";
  const changed = name !== organization?.name || logo !== organization?.logo;
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
  const submit = async () => {
    if (submitting.current || reading || !name.trim()) return;
    submitting.current = true;
    setError(null);
    try {
      const result = organization
        ? { spaceId: (await update.mutateAsync({ spaceId: organization.id, name, ...(logo !== organization.logo ? { logo } : {}) })).id, logoError: null }
        : await create.mutateAsync({ name, ...(logo ? { logo } : {}) });
      await onSaved({ ...result, pendingLogo: result.logoError ? logo : null });
      onOpenChange(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "OpenOrc Cloud can't be reached.");
    } finally {
      submitting.current = false;
    }
  };
  return (
    <form
      className="organization-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <LogoField logo={logo} pending={pending} reading={reading} pick={pick} remove={() => setLogo(null)} />
      <label className="organization-label">
        Name
        <Input
          variant="sheet"
          aria-label="Organization name"
          placeholder="Organization name"
          value={name}
          disabled={pending}
          autoFocus
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          aria-invalid={Boolean(error)}
        />
      </label>
      {error ? (
        <p className="organization-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="organization-actions">
        <Button onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!name.trim() || pending || reading || Boolean(organization && !changed)}>
          {pending ? working : action}
        </Button>
      </div>
    </form>
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
