import { useState } from "react";
import { FolderPath, inGitFolder, type FileRead, type FileScope } from "@openorc/protocol";
import { Button, Dialog, Field, Input } from "../components/ui";
import { filesKey } from "../lib/files-tool";
import { useLayout } from "../lib/layout";
import { core } from "../lib/rpc";
import { useUi } from "../lib/ui";

type Attempt = { kind: "typing" } | { kind: "creating" } | { kind: "refused"; message: string } | { kind: "exists"; path: FolderPath };

/** A typed path as a new file's place in the folder, or why it can't be one. */
function newFilePath(typed: string): { kind: "path"; path: FolderPath } | { kind: "refused"; message: string } {
  const parsed = FolderPath.safeParse(typed.trim());
  if (!parsed.success) return { kind: "refused", message: parsed.error.issues[0]?.message ?? "Use a path inside the conversation's folder." };
  if (inGitFolder(parsed.data)) return { kind: "refused", message: "Git's own files are read-only here." };
  return { kind: "path", path: parsed.data };
}

/** What stood at the path when the create-only write refused it. A file can be opened instead; nothing is overwritten. */
function refusal(current: FileRead): Attempt {
  if (current.kind === "file" || current.kind === "binary") return { kind: "exists", path: current.path };
  if (current.kind === "unreadable") return { kind: "refused", message: current.reason };
  return { kind: "typing" };
}

/** New file, from the Files tool or the command palette: a path in the folder, created empty and opened in a tab. */
export function NewFileDialog() {
  const scope = useUi((state) => state.newFile);
  return (
    <Dialog
      open={scope !== null}
      onOpenChange={(open) => {
        if (!open) useUi.getState().setNewFile(null);
      }}
      title="New file"
    >
      {scope ? <NewFileForm key={filesKey(scope)} scope={scope} /> : null}
    </Dialog>
  );
}

function NewFileForm({ scope }: { scope: FileScope }) {
  const [typed, setTyped] = useState("");
  const [attempt, setAttempt] = useState<Attempt>({ kind: "typing" });
  const open = (path: FolderPath) => {
    useUi.getState().setNewFile(null);
    useLayout.getState().openFile({ path, scope });
  };
  const create = async () => {
    const target = newFilePath(typed);
    if (target.kind === "refused") {
      setAttempt(target);
      return;
    }
    setAttempt({ kind: "creating" });
    try {
      const result = await core.call("files.write", { scope, path: target.path, text: "", expected: { kind: "absent" } });
      if (result.kind === "saved") open(result.path);
      else setAttempt(refusal(result.current));
    } catch (error) {
      setAttempt({ kind: "refused", message: error instanceof Error ? error.message : String(error) });
    }
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <Field label="Path">
        <Input
          autoFocus
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
            setAttempt({ kind: "typing" });
          }}
          placeholder="src/index.ts"
          className="font-mono"
          aria-invalid={attempt.kind === "refused" || undefined}
        />
      </Field>
      {attempt.kind === "refused" ? (
        <p role="alert" className="mb-3 text-sm text-bad break-words">
          {attempt.message}
        </p>
      ) : null}
      {attempt.kind === "exists" ? (
        <div role="status" className="mb-3 flex items-center gap-2 text-sm text-ink-2">
          <span className="min-w-0 flex-1">That file already exists.</span>
          <Button size="sm" onClick={() => open(attempt.path)}>
            Open
          </Button>
        </div>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={() => useUi.getState().setNewFile(null)}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!typed.trim() || attempt.kind === "creating"}>
          Create
        </Button>
      </div>
    </form>
  );
}
