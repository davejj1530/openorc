import { useState } from "react";
import type { HostedFileScope, TeamChatFile } from "@openorc/protocol";
import { useTeamChatContext } from "../lib/team-chat-context";
import { useTeamChatFileScope } from "../lib/team-chat-files";
import { formatBytes } from "../lib/file-imports";
import { useHostedAsset } from "../lib/use-hosted-asset";
import { core } from "../lib/rpc";
import { Download, FileText } from "./icons";
import { ThreadImage } from "./ThreadImages";
import { TextButton } from "./ui";
import "./composer-file.css";
import "../styles/team-chat-unread.css";

/** A message's files: images as authenticated previews, other files by name and size with Download. */
export function TeamChatFiles({ files, conversationId }: { files: readonly TeamChatFile[]; conversationId: string }) {
  const chat = useTeamChatContext();
  const scope = useTeamChatFileScope(chat ?? { accountId: "", spaceId: "", generation: 0, reach: "offline", current: () => false }, conversationId, Boolean(chat));
  if (!files.length) return null;
  return (
    <div className="team-chat-files">
      {files.map((file) => (
        <TeamChatFileItem key={file.id} file={file} scope={scope} />
      ))}
    </div>
  );
}

function TeamChatFileItem({ file, scope }: { file: TeamChatFile; scope: HostedFileScope | null }) {
  const reference = { id: file.id, name: file.name };
  const preview = useHostedAsset(scope && file.kind === "image" ? { kind: "thumbnail", scope, file: reference } : null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const download = async () => {
    if (!scope) throw new Error("This file isn't available in this space.");
    await core.call("hostedFiles.download", { scope, file: reference });
  };
  if (preview.state.kind === "ready") return <ThreadImage objectUrl={preview.state.url} alt={file.name} compact download={download} onInvalidated={preview.onInvalidated} onError={preview.failed} />;
  return (
    <div className="grid justify-items-start gap-1.5">
      <button
        type="button"
        className="team-chat-file"
        disabled={pending || !scope}
        aria-label={`Download ${file.name}`}
        onClick={() => {
          setPending(true);
          setError(null);
          void download()
            .catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "This file couldn't be downloaded. Try again."))
            .finally(() => setPending(false));
        }}
      >
        <FileText size={18} className="shrink-0 text-ink-3" />
        <span className="team-chat-file-text">
          <span className="team-chat-file-name" data-tip={file.name}>
            {file.name}
          </span>
          <span className="team-chat-file-size tabular">{formatBytes(file.bytes)}</span>
        </span>
        <Download size={16} className="shrink-0 text-ink-3" />
      </button>
      {error ? (
        <p role="alert" className="composer-file-refusal">
          {error}
        </p>
      ) : null}
      {preview.state.kind === "failed" ? (
        <TextButton tone="muted" className="text-xs" onClick={preview.retry}>
          Try again
        </TextButton>
      ) : null}
    </div>
  );
}
