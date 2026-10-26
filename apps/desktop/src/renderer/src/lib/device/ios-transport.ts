import type { ChannelOpener } from "./channels";
import { iosHome, iosKey, iosOrientation, iosTouch, nextOrientation } from "./input";
import { IosControlLink } from "./ios-control";
import { IosVideoFeed } from "./ios-video";
import { StatusReporter, Timers, type DeviceTransport, type FrameSink, type StreamEvents } from "./stream";

/** An iOS simulator: video on one channel, input on the helper's control socket. */
export class IosTransport implements DeviceTransport {
  private readonly timers = new Timers();
  private readonly status: StatusReporter;
  private readonly control: IosControlLink;
  private readonly video: IosVideoFeed;

  constructor(channels: ChannelOpener, deviceId: string, sink: FrameSink, events: StreamEvents) {
    this.status = new StatusReporter(events.status);
    this.control = new IosControlLink({ channels, deviceId, timers: this.timers, onScreen: events.screen, onInput: events.input });
    this.video = new IosVideoFeed({ channels, deviceId, sink, status: this.status, timers: this.timers });
  }

  start(): void {
    this.status.begin();
    this.control.start();
    this.video.start();
  }

  stop(): void {
    this.control.stop();
    this.video.stop();
    this.timers.clear();
  }

  touch: DeviceTransport["touch"] = (phase, point) => this.control.send(iosTouch(phase, point, this.control.screen));

  key: DeviceTransport["key"] = (event, phase) => {
    const message = iosKey(event.code, phase);
    if (message) this.control.send(message);
  };

  /** The helper takes HID key codes, which cannot carry arbitrary text. */
  paste: DeviceTransport["paste"] = () => {};

  press: DeviceTransport["press"] = (button) => {
    if (button === "home") this.control.send(iosHome());
    else if (button === "rotate") this.control.send(iosOrientation(nextOrientation(this.control.screen?.orientation ?? "portrait")));
  };
}
