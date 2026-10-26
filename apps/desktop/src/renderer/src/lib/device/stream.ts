import type { Point, ScreenGeometry, TouchPhase } from "./input";

/**
 * One viewing session's progress. Connecting lasts until its first frame, with why the last try failed if one did;
 * after that a dropped feed is reconnecting, so the screen keeps its last frame while it recovers. Failed means this
 * window cannot show the stream at all.
 */
export type StreamStatus = { kind: "connecting"; detail?: string } | { kind: "streaming" } | { kind: "reconnecting"; detail: string } | { kind: "failed"; reason: string };

export interface StreamEvents {
  status: (status: StreamStatus) => void;
  screen: (screen: ScreenGeometry) => void;
  input: (connected: boolean) => void;
}

export type DeviceButton = "home" | "rotate" | "back" | "recents";

/** What the screen asks of either platform's stream. */
export interface DeviceTransport {
  start: () => void;
  stop: () => void;
  touch: (phase: TouchPhase, point: Point) => void;
  key: (event: Pick<KeyboardEvent, "code" | "key" | "metaKey" | "ctrlKey">, phase: "down" | "up") => void;
  paste: (text: string) => void;
  press: (button: DeviceButton) => void;
}

export const RETRY_MS = 1_000;
const MAX_RETRY_MS = 8_000;
/** A feed that shows nothing for this long is reopened. */
export const STALL_MS = 15_000;

const detailOf = (status: StreamStatus | null) => (status && "detail" in status ? status.detail : undefined);

export class StatusReporter {
  private hadFrame = false;
  private losses = 0;
  private last: StreamStatus | null = null;

  constructor(private readonly emit: (status: StreamStatus) => void) {}

  begin(): void {
    this.hadFrame = false;
    this.losses = 0;
    this.report({ kind: "connecting" });
  }

  frame(): void {
    this.hadFrame = true;
    this.losses = 0;
    if (this.last?.kind !== "streaming") this.report({ kind: "streaming" });
  }

  /** Reports a dropped feed and returns how long to wait before reopening it: longer while tries keep failing. */
  lost(detail: string): number {
    this.report(this.hadFrame ? { kind: "reconnecting", detail } : { kind: "connecting", detail });
    return Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** this.losses++);
  }

  fail(reason: string): void {
    this.report({ kind: "failed", reason });
  }

  private report(status: StreamStatus): void {
    if (status.kind !== "failed" && status.kind === this.last?.kind && detailOf(status) === detailOf(this.last)) return;
    this.last = status;
    this.emit(status);
  }
}

/** Timeouts that all end together when the stream stops. */
export class Timers {
  private readonly ids = new Set<ReturnType<typeof setTimeout>>();

  after(ms: number, run: () => void): () => void {
    const id = setTimeout(() => {
      this.ids.delete(id);
      run();
    }, ms);
    this.ids.add(id);
    return () => {
      clearTimeout(id);
      this.ids.delete(id);
    };
  }

  clear(): void {
    for (const id of this.ids) clearTimeout(id);
    this.ids.clear();
  }
}

/** Runs `work` one value at a time on the newest value; values that arrive while it runs replace one another. */
export function latestOnly<T>(work: (value: T) => Promise<void>): (value: T) => void {
  let next: { value: T } | null = null;
  let running = false;
  const drain = async () => {
    running = true;
    try {
      while (next) {
        const { value } = next;
        next = null;
        await work(value);
      }
    } finally {
      running = false;
    }
  };
  return (value) => {
    next = { value };
    if (!running) void drain();
  };
}

/** Where frames land. The producer releases its source after `present` returns. */
export interface FrameSink {
  present: (source: CanvasImageSource, width: number, height: number) => boolean;
}

export function canvasSink(canvas: HTMLCanvasElement): FrameSink {
  return {
    present(source, width, height) {
      const context = canvas.getContext("2d");
      if (!context) return false;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.drawImage(source, 0, 0, width, height);
      return true;
    },
  };
}

/** Decodes and paints one JPEG unless the feed moved on meanwhile. True when it painted. */
export async function paintJpeg(bytes: Uint8Array<ArrayBuffer>, sink: FrameSink, isCurrent: () => boolean): Promise<boolean> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  } catch {
    return false;
  }
  try {
    return isCurrent() && sink.present(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

export function endDetail(end: { status?: number; reason?: string }): string {
  if (end.reason) return end.reason;
  return end.status ? `The device stream answered ${end.status}.` : "The device stream ended.";
}
