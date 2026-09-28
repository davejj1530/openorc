import { useEffect, useState } from "react";
import { Button, Dialog, Field, Input } from "../components/ui";
import { useRpcMutation } from "../lib/query";
import { useRouter } from "../lib/router";

export function ImportProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const importProject = useRpcMutation("projects.import");
  const navigate = useRouter((s) => s.navigate);
  const [path, setPath] = useState("");

  useEffect(() => {
    if (open) {
      setPath("");
      importProject.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Opening starts a fresh attempt; mutation status changes must not erase the path being edited.
  }, [open]);

  const submit = () => {
    if (!path.trim()) return;
    importProject.mutate(
      { rootPath: path.trim() },
      {
        onSuccess: (p) => {
          onOpenChange(false);
          navigate({ view: "project", projectId: p.id });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Import a repository">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Repository folder" hint="Any folder inside a git repository. OpenOrc reads its config files and never modifies the checkout.">
          <div className="flex gap-2">
            <Input autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/dev/project" className="font-mono" />
            <Button
              onClick={async () => {
                const picked = await window.openorc.pickDirectory();
                if (picked) setPath(picked);
              }}
            >
              Choose…
            </Button>
          </div>
        </Field>
        {importProject.error ? <div className="text-sm text-bad mb-3">{importProject.error.message}</div> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!path.trim() || importProject.isPending}>
            Import
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
