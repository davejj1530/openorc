import { useState } from "react";
import type { OrganizationIdentity } from "@openorc/protocol";
import { OrganizationMark } from "../components/OrganizationMark";
import { Dialog } from "../components/ui";
import { useOrganizationSave } from "../lib/organization-save";
import { IdentityForm } from "./IdentityForm";

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
      <OrganizationForm key={props.organization?.id ?? "create"} {...props} />
    </Dialog>
  );
}

function OrganizationForm({ organization, onOpenChange, onSaved }: Props) {
  const [name, setName] = useState(organization?.name ?? "");
  const [logo, setLogo] = useState(organization?.logo ?? null);
  const save = useOrganizationSave({ organization, name, logo, onSaved, close: () => onOpenChange(false) });
  let action = organization ? "Save changes" : "Create organization";
  if (save.saved) action = organization ? "Try again" : `Open ${name.trim()}`;
  let working = organization ? "Saving…" : "Creating…";
  if (save.saved) working = "Opening…";
  const completed = organization ? "Organization updated." : `You created ${name.trim()}.`;
  return (
    <IdentityForm
      name={name}
      image={logo}
      mark={<OrganizationMark logo={logo} size={48} />}
      nameLabel="Organization name"
      pictureLabel="Organization logo"
      pictureAction={logo ? "Change logo" : "Add logo"}
      pending={save.pending}
      unchanged={Boolean(organization && name === organization.name && logo === organization.logo && !save.saved)}
      saved={save.saved ? completed : undefined}
      error={save.error}
      action={action}
      working={working}
      setName={setName}
      setImage={setLogo}
      setError={save.setError}
      submit={save.submit}
      close={() => onOpenChange(false)}
    />
  );
}
