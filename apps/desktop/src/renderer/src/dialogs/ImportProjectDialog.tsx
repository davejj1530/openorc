import { Button, Dialog, Field, Input } from "../components/ui";
import type { Project } from "@openorc/protocol";
import { useEffect, useState } from "react";

import { newThread, useRouter } from "../lib/router";
import { useLayout } from "../lib/layout";
import { swapInPlace } from "../lib/motion";
import { queryClient, useRpcMutation } from "../lib/client";
import { core } from "../lib/rpc";

export function ImportProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const importProject = useRpcMutation("projects.import");
  const [path, setPath] = useState("");
  const [missing, setMissing] = useState<string | null>(null);
  const rootPath = path.trim();
  const create = rootPath === missing;

  useEffect(() => {
    if (open) {
      setPath("");
      setMissing(null);
      importProject.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Opening starts a fresh attempt; mutation status changes must not erase the path being edited.
  }, [open]);

  const chooseFolder = async () => {
    const picked = await window.openorc.pickDirectory();
    if (picked) setPath(picked);
  };

  const submit = async () => {
    if (!rootPath) return;
    if (!create && (await core.call("projects.folderMissing", { rootPath }).catch(() => false))) {
      importProject.reset();
      setMissing(rootPath);
      return;
    }
    importProject.mutate(
      { rootPath, create },
      {
        onSuccess: (p) => {
          // The project list is still refreshing; until it lands the new thread screen would call this project unavailable.
          queryClient.setQueryData<Project[]>(["projects.list", {}], (list) => (list && !list.some((known) => known.id === p.id) ? [...list, p] : list));
          onOpenChange(false);
          const open = () => {
            useLayout.getState().followProject(p.id);
            newThread(p.id);
          };
          // Added from the new thread screen, the project swaps in as if chosen in its question.
          if (useRouter.getState().route.view === "newthread") swapInPlace("project", open);
          else open();
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Import a project">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Folder" hint={create ? "This folder doesn’t exist yet." : undefined}>
          <div className="flex gap-2">
            <Input autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/dev/project" className="font-mono" />
            <Button onClick={() => void chooseFolder()}>Choose…</Button>
          </div>
        </Field>
        {importProject.error ? <div className="text-sm text-bad mb-3">{importProject.error.message}</div> : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!rootPath || importProject.isPending}>
            {create ? "Create and import" : "Import"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
