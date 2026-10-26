import type { ChannelOpener, DeviceChannel } from "./channels";
import { H264Decoder, webCodecsAvailable } from "./decoder";
import { avcCodecString, parseSemuPacket, scanAccessUnit } from "./h264";
import { androidButton, androidKey, androidKeyframeRequest, androidText, androidTouch, isVideoSession, type ScreenGeometry } from "./input";
import { endDetail, STALL_MS, StatusReporter, Timers, type DeviceTransport, type FrameSink, type StreamEvents } from "./stream";

/**
 * An Android emulator: one socket carries SEMU-framed H.264 and JSON events in, and JSON gestures and keys out. The
 * decoder configures itself from the first SPS it sees and asks for a keyframe whenever it has to start over.
 */
export class AndroidTransport implements DeviceTransport {
  private readonly timers = new Timers();
  private readonly status: StatusReporter;
  private readonly decoder: H264Decoder;
  private session = 0;
  private channel: DeviceChannel | null = null;
  private configuring = false;
  private keyframeAsked = false;
  private screen: ScreenGeometry | null = null;
  private cancelFirstFrame: (() => void) | null = null;

  constructor(
    private readonly channels: ChannelOpener,
    private readonly deviceId: string,
    private readonly sink: FrameSink,
    private readonly events: StreamEvents,
  ) {
    this.status = new StatusReporter(events.status);
    this.decoder = new H264Decoder({ frame: (frame) => this.paint(frame), error: () => this.restartDecoder() });
  }

  start(): void {
    this.status.begin();
    if (!webCodecsAvailable()) this.status.fail("This window cannot decode Android video.");
    else this.connect(++this.session);
  }

  stop(): void {
    this.session++;
    this.channel?.close();
    this.channel = null;
    this.decoder.close();
    this.timers.clear();
  }

  touch: DeviceTransport["touch"] = (phase, point) => this.send(androidTouch(phase, point));

  key: DeviceTransport["key"] = (event, phase) => {
    const message = phase === "down" ? androidKey(event) : null;
    if (message) this.send(message);
  };

  paste: DeviceTransport["paste"] = (text) => {
    for (const message of androidText(text)) this.send(message);
  };

  press: DeviceTransport["press"] = (button) => {
    if (button !== "rotate") this.send(androidButton(button));
  };

  private send(message: string): void {
    this.channel?.send(message);
  }

  private connect(session: number): void {
    this.configuring = false;
    this.keyframeAsked = false;
    this.channel = this.channels.open("android", this.deviceId, {
      opened: () => {
        if (session === this.session) this.events.input(true);
      },
      data: (data) => {
        if (session !== this.session) return;
        if (typeof data === "string") this.receiveText(data);
        else this.receivePacket(session, data);
      },
      closed: (end) => this.lost(session, endDetail(end)),
    });
    this.cancelFirstFrame = this.timers.after(STALL_MS, () => this.lost(session, "The emulator sent no video."));
  }

  private lost(session: number, detail: string): void {
    if (session !== this.session) return;
    const next = ++this.session;
    this.cancelFirstFrame?.();
    this.channel?.close();
    this.channel = null;
    this.decoder.close();
    this.events.input(false);
    this.timers.after(this.status.lost(detail), () => {
      if (this.session === next) this.connect(next);
    });
  }

  /** The encoder restarts at a new size when the device rotates; its next keyframe carries the new SPS. */
  private receiveText(text: string): void {
    if (!isVideoSession(text)) return;
    this.restartDecoder();
  }

  private restartDecoder(): void {
    this.decoder.close();
    this.configuring = false;
    this.keyframeAsked = false;
    this.askKeyframe();
  }

  /** One request per wait: every request restarts the encoder, which would only push the keyframe further out. */
  private askKeyframe(): void {
    if (this.keyframeAsked) return;
    this.keyframeAsked = true;
    this.send(androidKeyframeRequest());
  }

  private receivePacket(session: number, bytes: Uint8Array<ArrayBuffer>): void {
    const packet = parseSemuPacket(bytes);
    const configured = this.decoder.configured;
    const scanned = packet.isKey === null || (packet.isKey && !configured) ? scanAccessUnit(packet.data) : null;
    const isKey = packet.isKey ?? scanned?.isKey ?? false;
    if (isKey) this.keyframeAsked = false;
    if (!configured) {
      if (this.configuring) return;
      if (scanned?.sps) this.configure(session, scanned.sps);
      else if (!isKey) this.askKeyframe();
      return;
    }
    const decoded = this.decoder.decode(isKey, packet.data, packet.timestamp);
    if (decoded === "behind" || decoded === "failed") this.restartDecoder();
  }

  private configure(session: number, sps: Uint8Array): void {
    if (this.configuring) return;
    this.configuring = true;
    const codec = avcCodecString(sps);
    void this.decoder.configure({ codec }).then((result) => {
      if (session !== this.session || result === "stale") return;
      this.configuring = false;
      if (result === "configured") this.askKeyframe();
      else this.giveUp(`This window cannot decode the emulator's ${codec} video.`);
    });
  }

  /** Reconnecting would meet the same decoder, so the stream ends here and says why. */
  private giveUp(reason: string): void {
    this.stop();
    this.events.input(false);
    this.status.fail(reason);
  }

  private paint(frame: VideoFrame): void {
    const { displayWidth: width, displayHeight: height } = frame;
    if (this.screen?.width !== width || this.screen.height !== height) {
      this.screen = { width, height, orientation: width > height ? "landscape_left" : "portrait" };
      this.events.screen(this.screen);
    }
    if (!this.sink.present(frame, width, height)) return;
    this.cancelFirstFrame?.();
    this.cancelFirstFrame = null;
    this.status.frame();
  }
}
