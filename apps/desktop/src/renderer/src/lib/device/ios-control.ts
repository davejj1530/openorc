import type { ChannelOpener, DeviceChannel } from "./channels";
import { parseIosControl, type ScreenGeometry } from "./input";
import { RETRY_MS, type Timers } from "./stream";

/** How long the MJPEG touch that wakes the helper may take before the control socket opens anyway. */
const PRIME_MS = 2_000;

type ControlDeps = {
  channels: ChannelOpener;
  deviceId: string;
  timers: Timers;
  onScreen: (screen: ScreenGeometry) => void;
  onInput: (connected: boolean) => void;
};

/**
 * The iOS helper's control socket: screen config in, touches, buttons, keys and orientation out. Input counts only
 * once the helper admits it, and the socket reconnects whenever it drops.
 */
export class IosControlLink {
  screen: ScreenGeometry | null = null;
  private session = 0;
  private channel: DeviceChannel | null = null;
  private admitted = false;
  private unavailable = false;
  private endPrime: (() => void) | null = null;

  constructor(private readonly deps: ControlDeps) {}

  start(): void {
    void this.connect(++this.session);
  }

  stop(): void {
    this.session++;
    this.endPrime?.();
    this.channel?.close();
    this.channel = null;
    this.admitted = false;
  }

  /** Sends only while the helper accepts input; earlier input would be dropped there anyway. */
  send(message: ArrayBuffer): void {
    if (this.admitted && !this.unavailable) this.channel?.send(message);
  }

  private async connect(session: number): Promise<void> {
    await this.prime();
    if (session !== this.session) return;
    this.admitted = false;
    this.unavailable = false;
    this.channel = this.deps.channels.open("ios-control", this.deps.deviceId, {
      data: (data) => {
        if (session === this.session && typeof data !== "string") this.receive(data);
      },
      closed: () => {
        if (session !== this.session) return;
        this.channel = null;
        this.admitted = false;
        this.deps.onInput(false);
        this.deps.timers.after(RETRY_MS, () => {
          if (session === this.session) void this.connect(session);
        });
      },
    });
  }

  /**
   * serve-sim's helper accepts input and reports its screen only once capture runs, and the AVCC stream does not
   * reliably start it. Touching the MJPEG stream does: the first bytes, or a short wait, are enough.
   */
  private prime(): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        if (this.endPrime !== finish) return;
        this.endPrime = null;
        cancel();
        channel.close();
        resolve();
      };
      const channel = this.deps.channels.open("ios-mjpeg", this.deps.deviceId, { data: finish, closed: finish });
      const cancel = this.deps.timers.after(PRIME_MS, finish);
      this.endPrime = finish;
    });
  }

  private receive(bytes: Uint8Array): void {
    const event = parseIosControl(bytes);
    if (event.kind === "admitted") {
      this.admitted = true;
      this.deps.onInput(!this.unavailable);
    } else if (event.kind === "screen") {
      this.unavailable = event.inputUnavailable;
      this.screen = event.screen;
      this.deps.onScreen(event.screen);
      this.deps.onInput(this.admitted && !this.unavailable);
    }
  }
}
