import { useState } from "react";
import type { BinaryFile } from "@openorc/protocol";
import { FilePlain } from "../components/icons";
import { Button } from "../components/ui";
import { formatBytes } from "../lib/file-imports";
import { noteFile } from "../lib/use-file-buffer";

export function revealLabel(platform: string): string {
  if (platform === "darwin") return "Show in Finder";
  return platform === "win32" ? "Show in Explorer" : "Show in folder";
}

/** Opens the file in its default app. When it could not, the file's quiet line says why. */
export async function openBinaryFile(file: BinaryFile): Promise<void> {
  const problem = await window.openorc.openFile(file.url).catch(() => "Could not open this file.");
  noteFile(file, problem || null);
}

function Media({ file, name, onError }: { file: BinaryFile; name: string; onError: () => void }) {
  if (file.media === "image") return <img src={file.url} alt={name} onError={onError} className="max-h-full max-w-full object-contain" />;
  if (file.media === "video") return <video src={file.url} controls preload="metadata" onError={onError} className="max-h-full max-w-full" />;
  return <audio src={file.url} controls preload="metadata" onError={onError} />;
}

/** A file the panel shows rather than edits: a viewer for media the window can show, or the file's name and size with Open. */
export function BinaryView({ file }: { file: BinaryFile }) {
  const name = file.path.split("/").pop() ?? file.path;
  const [failed, setFailed] = useState(false);
  if (file.media === "pdf") return <iframe src={file.url} title={name} className="flex-1 min-h-0 w-full border-0" />;
  const shown = file.media !== "other" && !failed;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6">
      {shown ? <Media file={file} name={name} onError={() => setFailed(true)} /> : null}
      {file.media === "other" ? (
        <>
          <FilePlain size={28} className="text-ink-3" />
          <div className="text-center">
            <p className="text-base text-ink">{name}</p>
            <p className="text-sm text-ink-3 tabular">{formatBytes(file.size)}</p>
          </div>
        </>
      ) : null}
      {failed ? (
        <p role="status" className="text-sm text-ink-3">
          Could not show this file.
        </p>
      ) : null}
      {shown ? null : (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void openBinaryFile(file)}>
            Open
          </Button>
          <Button size="sm" onClick={() => window.openorc.revealFile(file.absolutePath)}>
            {revealLabel(window.openorc.platform)}
          </Button>
        </div>
      )}
    </div>
  );
}
