import { useState } from "react";
import { Download } from "./icons";
import { Button } from "./ui";

export function ImageDownload({ name, download }: { name: string; download(): Promise<unknown> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      {error ? (
        <span role="alert" className="text-xs text-ink-3">
          {error}
        </span>
      ) : null}
      <Button
        variant="ghost"
        aria-label={`Download ${name}`}
        data-tip={`Download ${name}`}
        disabled={pending}
        onClick={() => {
          setPending(true);
          setError(null);
          void download()
            .catch((error: unknown) => setError(error instanceof Error ? error.message : "This file couldn't be downloaded. Try again."))
            .finally(() => setPending(false));
        }}
      >
        <Download size={16} />
      </Button>
    </span>
  );
}
