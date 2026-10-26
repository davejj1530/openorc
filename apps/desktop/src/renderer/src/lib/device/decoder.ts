/** Past this many queued chunks the decoder has fallen behind the live screen and should start over. */
const SOFT_DECODE_QUEUE = 8;
const FRAME_DURATION_US = 16_667;

export type ConfigureResult = "configured" | "unsupported" | "stale";
export type DecodeResult = "decoded" | "waiting" | "behind" | "failed";

export const webCodecsAvailable = (): boolean => "VideoDecoder" in globalThis && "EncodedVideoChunk" in globalThis;

/**
 * WebCodecs H.264 at live latency. Each decoded frame goes to `frame` and is closed after it returns. Closing makes
 * every configure still waiting on its support check stale, so a restarted feed never adopts an old configuration.
 */
export class H264Decoder {
  private decoder: VideoDecoder | null = null;
  private epoch = 0;
  private awaitingKey = true;
  private timestamp = 0;

  constructor(private readonly handlers: { frame: (frame: VideoFrame) => void; error: () => void }) {}

  get configured(): boolean {
    return this.decoder?.state === "configured";
  }

  async configure(config: VideoDecoderConfig): Promise<ConfigureResult> {
    const epoch = this.epoch;
    const full: VideoDecoderConfig = { ...config, optimizeForLatency: true };
    const support = await VideoDecoder.isConfigSupported(full).catch(() => ({ supported: false }));
    if (epoch !== this.epoch) return "stale";
    if (!support.supported) return "unsupported";
    try {
      if (!this.decoder || this.decoder.state === "closed") this.decoder = this.create();
      this.decoder.configure(full);
      this.awaitingKey = true;
      return "configured";
    } catch {
      return "unsupported";
    }
  }

  /** Decodes one access unit. Deltas before the first keyframe wait; a deep queue reports `behind`. */
  decode(isKey: boolean, data: Uint8Array<ArrayBuffer>, timestamp?: number | null): DecodeResult {
    if (!this.decoder || this.decoder.state !== "configured") return "waiting";
    if (this.awaitingKey && !isKey) return "waiting";
    this.awaitingKey = false;
    if (this.decoder.decodeQueueSize > SOFT_DECODE_QUEUE) return "behind";
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp: timestamp ?? this.timestamp, data }));
      this.timestamp += FRAME_DURATION_US;
      return "decoded";
    } catch {
      return "failed";
    }
  }

  close(): void {
    this.epoch++;
    const decoder = this.decoder;
    this.decoder = null;
    this.awaitingKey = true;
    try {
      decoder?.close();
    } catch {
      // Already closed by an error.
    }
  }

  private create(): VideoDecoder {
    const decoder = new VideoDecoder({
      output: (frame) => {
        try {
          if (this.decoder === decoder) this.handlers.frame(frame);
        } finally {
          frame.close();
        }
      },
      error: () => {
        if (this.decoder === decoder) this.handlers.error();
      },
    });
    return decoder;
  }
}
