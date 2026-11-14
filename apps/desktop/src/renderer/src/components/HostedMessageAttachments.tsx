import { useState } from "react";
import { hostedFileReference, type HostedFileScope, type ThreadSummary } from "@openorc/protocol";
import { isImagePath } from "../../../shared/image-paths";
import { useHostedFileScope } from "../lib/hosted-file-scope";
import { useHostedAsset } from "../lib/use-hosted-asset";
import { core } from "../lib/rpc";
import { FileText } from "./icons";
import { ThreadImage } from "./ThreadImages";
import { TextButton } from "./ui";
import "./composer-file.css";

export function HostedMessageAttachments({ thread, paths }: { thread: ThreadSummary; paths: string[] }) {
  const scope = useHostedFileScope({ projectId: thread.projectId, threadId: thread.id, enabled: true });
  return (
    <div className="flex flex-wrap items-start justify-end gap-2">
      {paths.map((path) => (
        <HostedMessageFile key={path} path={path} scope={scope} />
      ))}
    </div>
  );
}

function HostedMessageFile({ path, scope }: { path: string; scope: HostedFileScope | null }) {
  const file = hostedFileReference(path);
  const name = file?.name ?? path.split("/").pop() ?? "Attached file";
  const preview = useHostedAsset(file && scope && isImagePath(name) ? { kind: "thumbnail", scope, file } : null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const download = async () => {
    if (!file || !scope) throw new Error("This file isn't available in this space.");
    await core.call("hostedFiles.download", { scope, file });
  };
  if (preview.state.kind === "ready") return <ThreadImage objectUrl={preview.state.url} alt={name} compact download={download} onInvalidated={preview.onInvalidated} onError={preview.failed} />;
  return (
    <div className="grid justify-items-start gap-1.5">
      <button
        type="button"
        className="attached-file"
        disabled={pending || !scope || !file}
        data-tip={`Download ${name}`}
        onClick={() => {
          setPending(true);
          setError(null);
          void download()
            .catch((error: unknown) => setError(error instanceof Error ? error.message : "This file couldn't be downloaded. Try again."))
            .finally(() => setPending(false));
        }}
      >
        <FileText size={16} className="shrink-0 text-ink-4" />
        <span className="truncate">{name}</span>
      </button>
      {error ? (
        <p role="alert" className="composer-file-refusal">
          {error}
        </p>
      ) : null}
      {preview.state.kind === "failed" ? (
        <>
          {preview.state.message !== error ? (
            <p role="alert" className="composer-file-refusal">
              {preview.state.message}
            </p>
          ) : null}
          <TextButton tone="muted" className="text-xs" onClick={preview.retry}>
            Try again
          </TextButton>
        </>
      ) : null}
    </div>
  );
}
