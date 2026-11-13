import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Mode, ThemePreset } from "@openorc/client/theme";

const viewport = { width: 1120, height: 700 };

/** A separate renderer keeps example data, stores, and effects out of the setup window. */
export function WorkspaceAppearancePreview({ colors, mode, preset }: { colors: CSSProperties; mode: Mode; preset: ThemePreset }) {
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [scale, setScale] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const element = container.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setScale(entry.contentRect.width / viewport.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const apply = () => frame.current?.contentWindow?.postMessage({ type: "openorc:appearance", colors, mode, preset, font: document.documentElement.dataset.font }, "*");
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.data?.type !== "openorc:appearance-ready") return;
      apply();
      setReady(true);
    };
    window.addEventListener("message", receive);
    apply();
    return () => window.removeEventListener("message", receive);
  }, [colors, mode, preset]);

  return (
    <div className="onboarding-workspace-preview" ref={container} style={{ aspectRatio: `${viewport.width} / ${viewport.height}` }} inert>
      <iframe
        ref={frame}
        title="OpenOrc workspace preview"
        src={new URL("appearance-preview.html", window.location.href).href}
        tabIndex={-1}
        sandbox="allow-scripts allow-same-origin"
        data-ready={ready || undefined}
        style={{ width: viewport.width, height: viewport.height, transform: `scale(${scale})` }}
      />
    </div>
  );
}
