import { useRef, useState } from "react";
import type { AccountStatus } from "@openorc/protocol";
import { AccountFace } from "../components/AccountFace";
import { Dialog } from "../components/ui";
import { queryClient, useRpcMutation } from "../lib/client";
import { IdentityForm } from "./IdentityForm";

export function ProfileDialog({ account, close }: { account: Extract<AccountStatus, { state: "signed-in" }>; close(): void }) {
  const [initial] = useState(account);
  const [name, setName] = useState(account.name ?? "");
  const [image, setImage] = useState(account.image);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const save = useRpcMutation("account.profile.update");
  const submit = async () => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      const stored = await save.mutateAsync({ ...(name !== initial.name ? { name } : {}), ...(image !== initial.image ? { image } : {}) });
      queryClient.setQueryData(["account.status", {}], stored);
      close();
    } catch (error) {
      setError(error instanceof Error ? error.message : "OpenOrc Cloud can't be reached.");
    } finally {
      busy.current = false;
    }
  };
  return (
    <Dialog
      open
      title="Edit profile"
      width={420}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <IdentityForm
        name={name}
        image={image}
        mark={<AccountFace name={name || account.email} image={image} className="profile-dialog-face" />}
        nameLabel="Name"
        pictureLabel="Profile picture"
        pictureAction="Change picture"
        pending={save.isPending}
        unchanged={name === (initial.name ?? "") && image === initial.image}
        error={error}
        action="Save changes"
        working="Saving…"
        setName={setName}
        setImage={setImage}
        setError={setError}
        submit={submit}
        close={close}
      />
    </Dialog>
  );
}
