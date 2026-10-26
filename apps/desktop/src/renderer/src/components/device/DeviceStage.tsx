import { useLayoutEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefCallback } from "react";
import type { Device } from "@openorc/protocol";
import type { Point } from "../../lib/device/input";
import type { ScreenPhase } from "../../lib/device/screen-phase";
import { fitFrame, mediaBox, screenAspect, screenCorner, screenRotation } from "../../lib/device/screen-layout";
import type { DeviceTransport } from "../../lib/device/stream";
import type { StreamView } from "../../lib/device/use-device-stream";
import { Button } from "../ui";

function useElementSize(element: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

function pointIn(event: PointerEvent<HTMLElement>): Point {
  const rect = event.currentTarget.getBoundingClientRect();
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
}

/** Click and drag is a touch: down begins it, moves follow while the pointer is held, and up or a cancel ends it. */
function useTouches(transport: DeviceTransport | null) {
  const touching = useRef(false);
  const end = (event: PointerEvent<HTMLElement>) => {
    if (!touching.current) return;
    touching.current = false;
    transport?.touch("end", pointIn(event));
  };
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (!transport || event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
      touching.current = true;
      transport.touch("begin", pointIn(event));
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (touching.current) transport?.touch("move", pointIn(event));
    },
    onPointerUp: end,
    onPointerCancel: end,
  };
}

/** Keys go to the device while the screen has focus. App shortcuts, Tab and the paste chords stay with the app. */
const keepsKey = (event: KeyboardEvent<HTMLElement>) => event.metaKey || event.key === "Tab" || (event.ctrlKey && event.key.toLowerCase() === "v") || (event.shiftKey && event.key === "Insert");

/**
 * Every key that went down comes back up, even when a modifier pressed meanwhile would keep the release with the
 * app or focus leaves first; otherwise the simulator holds the key.
 */
function useTyping(transport: DeviceTransport | null) {
  const held = useRef(new Set<string>());
  const release = (code: string) => {
    held.current.delete(code);
    transport?.key({ code, key: "", metaKey: false, ctrlKey: false }, "up");
  };
  return {
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!transport || keepsKey(event)) return;
      event.preventDefault();
      held.current.add(event.code);
      transport.key(event.nativeEvent, "down");
    },
    onKeyUp: (event: KeyboardEvent<HTMLElement>) => {
      if (held.current.has(event.code)) release(event.code);
    },
    onBlur: () => {
      for (const code of [...held.current]) release(code);
    },
    onPaste: (event: ClipboardEvent<HTMLElement>) => {
      if (!transport) return;
      event.preventDefault();
      transport.paste(event.clipboardData.getData("text/plain"));
    },
  };
}

function ScreenOverlay({ phase, onStart }: { phase: ScreenPhase; onStart: () => void }) {
  if (phase.kind === "shutdown")
    return (
      <div className="device-overlay motion-arrive">
        <Button variant="primary" onClick={onStart}>
          Start
        </Button>
      </div>
    );
  if (phase.kind === "starting" || phase.kind === "stopping")
    return (
      <div className="device-overlay motion-arrive" role="status">
        <span className="device-progress">
          <span className="reply-pulse" aria-hidden="true" />
          {phase.kind === "starting" ? "Starting" : "Shutting down"}
        </span>
        {phase.kind === "starting" && phase.detail ? <p>{phase.detail}</p> : null}
      </div>
    );
  if (phase.kind === "unavailable")
    return (
      <div className="device-overlay motion-arrive" role="status">
        <p>{phase.reason}</p>
      </div>
    );
  return null;
}

/** The device's screen at the largest size the tab allows, in its own shape whatever state it is in. */
export function DeviceStage(props: { device: Device; phase: ScreenPhase; view: StreamView; transport: DeviceTransport | null; canvasRef: RefCallback<HTMLCanvasElement>; onStart: () => void }) {
  const { device, phase, view } = props;
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const live = phase.kind === "streaming" || phase.kind === "reconnecting";
  const transport = live ? props.transport : null;
  const frame = fitFrame(screenAspect(device, view.screen), useElementSize(stage));
  const touches = useTouches(transport);
  const typing = useTyping(transport);
  const frameStyle = { width: frame.width, height: frame.height, "--device-corner": `${screenCorner(frame, device.formFactor)}px` } as CSSProperties;
  return (
    <div ref={setStage} className="device-stage">
      <div className="device-frame" style={frameStyle} tabIndex={live ? 0 : -1} role="application" aria-label={`${device.name} screen`} {...touches} {...typing}>
        <canvas ref={props.canvasRef} className="device-media" data-hidden={!live || undefined} style={mediaBox(frame, screenRotation(device.platform, view.screen))} />
        <ScreenOverlay key={phase.kind} phase={phase} onStart={props.onStart} />
        {phase.kind === "reconnecting" ? (
          <span className="device-reconnecting" role="status">
            Reconnecting
          </span>
        ) : null}
      </div>
    </div>
  );
}
