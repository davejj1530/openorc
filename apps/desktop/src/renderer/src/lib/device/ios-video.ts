import { simulatorAvcConfig } from "./avc-config";
import type { ChannelOpener, DeviceChannel } from "./channels";
import { H264Decoder, webCodecsAvailable } from "./decoder";
import { AvccDemuxer, avcCodecString, type AvccChunk } from "./h264";
import { MultipartJpegParser, multipartBoundary } from "./mjpeg";
import { endDetail, latestOnly, paintJpeg, STALL_MS, type FrameSink, type StatusReporter, type Timers } from "./stream";

type VideoDeps = { channels: ChannelOpener; deviceId: string; sink: FrameSink; status: StatusReporter; timers: Timers };

/**
 * An iOS simulator's screen. H.264 over AVCC through WebCodecs, painting the JPEG seed until the first decoded frame;
 * MJPEG when this window cannot decode the simulator's H.264. Every open is a feed: anything async checks it is still
 * the current feed before it touches the screen, and a dropped feed reopens after a short wait.
 */
export class IosVideoFeed {
  private mode: "avcc" | "mjpeg" = webCodecsAvailable() ? "avcc" : "mjpeg";
  private feed = 0;
  private channel: DeviceChannel | null = null;
  private decodedFeed = -1;
  private pending: AvccChunk[] = [];
  private pumpingFeed: number | null = null;
  private cancelStall: (() => void) | null = null;
  private readonly decoder: H264Decoder;

  constructor(private readonly deps: VideoDeps) {
    this.decoder = new H264Decoder({
      frame: (frame) => {
        this.decodedFeed = this.feed;
        if (this.deps.sink.present(frame, frame.displayWidth, frame.displayHeight)) this.deps.status.frame();
      },
      error: () => this.fallBack(),
    });
  }

  start(): void {
    this.open();
  }

  stop(): void {
    this.closeFeed();
  }

  private open(): void {
    const feed = ++this.feed;
    if (this.mode === "avcc") this.openAvcc(feed);
    else this.openMjpeg(feed);
  }

  private closeFeed(): void {
    this.feed++;
    this.cancelStall?.();
    this.cancelStall = null;
    this.channel?.close();
    this.channel = null;
    this.pending = [];
    this.decoder.close();
  }

  private lost(feed: number, detail: string): void {
    if (feed !== this.feed) return;
    this.closeFeed();
    this.deps.timers.after(this.deps.status.lost(detail), () => {
      if (this.feed === feed + 1) this.open();
    });
  }

  /** Reopens a feed that goes quiet: an AVCC body can stay open after its helper stops producing frames. */
  private watch(feed: number): void {
    this.cancelStall?.();
    this.cancelStall = this.deps.timers.after(STALL_MS, () => this.lost(feed, "The device stopped sending video."));
  }

  private fallBack(): void {
    if (this.mode === "mjpeg") return;
    this.mode = "mjpeg";
    this.closeFeed();
    this.open();
  }

  private openAvcc(feed: number): void {
    const demuxer = new AvccDemuxer();
    this.channel = this.deps.channels.open("ios-video", this.deps.deviceId, {
      data: (data) => {
        if (feed !== this.feed || typeof data === "string") return;
        this.watch(feed);
        try {
          this.pending.push(...demuxer.push(data));
        } catch {
          this.lost(feed, "The device stream lost its framing.");
          return;
        }
        void this.pump(feed);
      },
      closed: (end) => this.lost(feed, endDetail(end)),
    });
    this.watch(feed);
  }

  /** Handles chunks strictly in order, waiting out a decoder configuration while later chunks queue. */
  private async pump(feed: number): Promise<void> {
    if (this.pumpingFeed === feed) return;
    this.pumpingFeed = feed;
    try {
      while (feed === this.feed && this.pending.length > 0) await this.handle(feed, this.pending.shift()!);
    } finally {
      if (this.pumpingFeed === feed) this.pumpingFeed = null;
    }
  }

  private async handle(feed: number, chunk: AvccChunk): Promise<void> {
    if (chunk.type === "seed") {
      if (this.decodedFeed !== feed) void this.paintSeed(feed, chunk.payload);
      return;
    }
    if (chunk.type === "description") {
      const result = await this.decoder.configure({ codec: avcCodecString(chunk.payload), description: simulatorAvcConfig(chunk.payload) });
      if (feed === this.feed && result === "unsupported") this.fallBack();
      return;
    }
    const decoded = this.decoder.decode(chunk.type === "keyframe", chunk.payload);
    // A fresh subscription forces a fresh keyframe; an idle simulator may otherwise not send one for minutes.
    if (decoded === "behind") this.lost(feed, "Video fell behind.");
    else if (decoded === "failed") this.fallBack();
  }

  private async paintSeed(feed: number, jpeg: Uint8Array<ArrayBuffer>): Promise<void> {
    if (await paintJpeg(jpeg, this.deps.sink, () => feed === this.feed && this.decodedFeed !== feed)) this.deps.status.frame();
  }

  private openMjpeg(feed: number): void {
    let parser = new MultipartJpegParser("frame");
    let painted = false;
    const show = latestOnly(async (jpeg: Uint8Array<ArrayBuffer>) => {
      if (!(await paintJpeg(jpeg, this.deps.sink, () => feed === this.feed))) return;
      this.deps.status.frame();
      // The hub writes a part only when the screen changes, so after the first frame silence is normal.
      if (!painted) this.cancelStall?.();
      painted = true;
    });
    this.channel = this.deps.channels.open("ios-mjpeg", this.deps.deviceId, {
      opened: (contentType) => {
        parser = new MultipartJpegParser(multipartBoundary(contentType) ?? "frame");
      },
      data: (data) => {
        if (feed !== this.feed || typeof data === "string") return;
        const latest = parser.push(data).at(-1);
        if (latest) show(latest);
      },
      closed: (end) => this.lost(feed, endDetail(end)),
    });
    this.watch(feed);
  }
}
