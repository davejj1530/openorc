import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Home, RefreshCw } from "./icons";
import { IconButton, Tooltip } from "./ui";
import { cn } from "../lib/cn";

export function typedUrl(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (/\s/.test(text) || !/[.:/]/.test(text)) return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
  return `http://${text}`;
}

export interface PanelNavigationProps {
  address: string;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onHome: () => void;
  onNavigate: (url: string) => void;
  onReload?: () => void;
  loading?: boolean;
  focusAddress?: boolean;
}

export function PanelNavigation({ address, canGoBack, canGoForward, onBack, onForward, onHome, onNavigate, onReload, loading, focusAddress }: PanelNavigationProps) {
  const [draft, setDraft] = useState(address);
  const input = useRef<HTMLInputElement>(null);
  const typing = useRef(false);
  useEffect(() => {
    if (!typing.current) setDraft(address);
  }, [address]);
  useEffect(() => {
    if (focusAddress) input.current?.focus();
  }, [focusAddress]);
  return (
    <div className="panel-navigation">
      <Tooltip label="Back">
        <IconButton aria-label="Back" disabled={!canGoBack} onClick={onBack}>
          <ChevronLeft size={16} />
        </IconButton>
      </Tooltip>
      <Tooltip label="Forward">
        <IconButton aria-label="Forward" disabled={!canGoForward} onClick={onForward}>
          <ChevronRight size={16} />
        </IconButton>
      </Tooltip>
      <form
        className="panel-address"
        onSubmit={(event) => {
          event.preventDefault();
          const url = typedUrl(draft);
          if (!url) return;
          typing.current = false;
          setDraft(url);
          input.current?.blur();
          onNavigate(url);
        }}
      >
        <input
          ref={input}
          aria-label="Preview address"
          placeholder="Search or enter a URL"
          spellCheck={false}
          autoComplete="off"
          value={draft}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            typing.current = true;
            setDraft(event.target.value);
          }}
          onBlur={() => {
            typing.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(address);
              input.current?.blur();
            }
          }}
        />
        <Tooltip label="Reload">
          <IconButton size="xs" aria-label="Reload" disabled={!onReload} onClick={onReload} className="hover:bg-surface-3">
            <RefreshCw size={14} className={cn(loading && "animate-spin")} />
          </IconButton>
        </Tooltip>
      </form>
      <Tooltip label="Tools">
        <IconButton aria-label="Tools" onClick={onHome}>
          <Home size={15} />
        </IconButton>
      </Tooltip>
    </div>
  );
}
