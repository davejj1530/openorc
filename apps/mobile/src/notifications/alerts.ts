import type { ClientPush } from "@openorc/client";
import { PUSH_SENDER_TAG, type DeviceMethod, type DeviceParams, type DeviceRpcResults, type PushEnvironment } from "@openorc/protocol";
import type { LinkState } from "../connection/manager";
import { DEFAULT_PREFS, registrationFor, type AlertChoice, type AlertPrefs, type MacSender, type Permission } from "./registration";

/** iOS's side of alerts: permission, this launch's APNs token and the environment the build's profile gives it. */
export interface PushPlatform {
  permission(): Promise<Permission>;
  ask(): Promise<Permission>;
  environment(): Promise<PushEnvironment>;
  /** Read at every launch, never kept: APNs issues a new one after a restore or a reinstall. */
  token(): Promise<string>;
  onToken(listener: (token: string) => void): () => void;
}

export interface AlertsLink {
  subscribe(listener: () => void): () => void;
  getState(): LinkState;
  forget(macId: string): Promise<void>;
  connection: {
    device<M extends DeviceMethod>(method: M, params: DeviceParams<M>): Promise<DeviceRpcResults[M]>;
    onPush(listener: (push: ClientPush) => void): () => void;
  };
}

interface KeyValue {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
}

export interface AlertsState {
  /** Null until iOS has answered. */
  permission: Permission | null;
  prefs: AlertPrefs;
  /** What each Mac said the last time this phone registered with it. */
  senders: ReadonlyMap<string, MacSender>;
}

/** MMKV `notifications`: the choice, its sound, and whether the one automatic iOS prompt has been shown. */
const KEY = "notifications";
const NOT_FROM_PHONE = "This is not available from a phone.";
const FORGET_WAIT_MS = 2_000;

function readSaved(storage: KeyValue): AlertPrefs & { asked: boolean } {
  try {
    const value: unknown = JSON.parse(storage.getString(KEY) ?? "null");
    if (value && typeof value === "object") {
      const { choice, sound, asked } = value as Record<string, unknown>;
      if ((choice === "all" || choice === "needs-you" || choice === "off") && typeof sound === "boolean") return { choice, sound, asked: asked === true };
    }
  } catch {
    // An unreadable value reads as never set.
  }
  return { ...DEFAULT_PREFS, asked: false };
}

/**
 * Keeps each Mac this phone shows told which alerts it wants: on every new session, at once on any change, and again
 * when the Mac says whether it can send changed. Asks iOS by itself only once, the first time a Mac says it can send,
 * since a prompt with nothing to send is noise.
 */
export class PhoneAlerts {
  private state: AlertsState;
  private asked: boolean;
  private token: string | null = null;
  private tokenAsked = false;
  /** A registration waits for this launch's token. */
  private awaitingToken = false;
  private environment: PushEnvironment = "production";
  private ready: Promise<void> = Promise.resolve();
  private serial: number | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: { link: AlertsLink; platform: PushPlatform; storage: KeyValue }) {
    const { asked, ...prefs } = readSaved(deps.storage);
    this.asked = asked;
    this.state = { permission: null, prefs, senders: new Map() };
  }

  getState = (): AlertsState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    this.ready = this.readIos();
    this.deps.platform.onToken((token) => {
      this.token = token;
      void this.registerShown();
    });
    this.deps.link.subscribe(() => this.linkChanged());
    // The Mac's key was added, removed or refused: hear what it can do now, and ask iOS if it just became ready.
    this.deps.link.connection.onPush((push) => {
      if (push.type === "invalidate" && push.keys.includes(PUSH_SENDER_TAG)) void this.registerShown(true);
    });
    this.linkChanged();
  }

  async choose(choice: AlertChoice): Promise<void> {
    await this.ready;
    this.setPrefs({ ...this.state.prefs, choice });
    if (choice !== "off" && this.state.permission === "undetermined") await this.ask();
    await this.registerShown();
  }

  async setSound(sound: boolean): Promise<void> {
    await this.ready;
    this.setPrefs({ ...this.state.prefs, sound });
    await this.registerShown();
  }

  /** iOS Settings may have changed while the app was away. */
  async refresh(): Promise<void> {
    await this.ready;
    const before = this.state.permission;
    this.permissionIs(await this.deps.platform.permission());
    if (this.state.permission !== before) await this.registerShown();
  }

  /** Stops that Mac's alerts first, while it can still hear this phone, then forgets it as the link does. */
  async forget(macId: string): Promise<void> {
    const state = this.deps.link.getState();
    if (state.kind === "connected" && state.mac.id === macId) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<void>((resolve) => (timer = setTimeout(resolve, FORGET_WAIT_MS)));
      await Promise.race([this.deps.link.connection.device("push.register", { registration: null }).catch(() => undefined), waited]);
      clearTimeout(timer);
    }
    await this.deps.link.forget(macId);
  }

  private async readIos(): Promise<void> {
    this.environment = await this.deps.platform.environment();
    this.permissionIs(await this.deps.platform.permission());
  }

  private permissionIs(permission: Permission): void {
    this.update({ permission });
    if (permission === "granted") this.readToken();
  }

  /** Once per launch. APNs may take a while to answer, or not answer at all without a network. */
  private readToken(): void {
    if (this.token !== null || this.tokenAsked) return;
    this.tokenAsked = true;
    this.deps.platform.token().then(
      (token) => {
        this.token = token;
        if (!this.awaitingToken) return;
        this.awaitingToken = false;
        void this.registerShown();
      },
      () => (this.tokenAsked = false),
    );
  }

  private async ask(): Promise<Permission> {
    this.asked = true;
    this.save();
    const permission = await this.deps.platform.ask();
    this.permissionIs(permission);
    return permission;
  }

  private linkChanged(): void {
    const state = this.deps.link.getState();
    if (state.kind !== "connected" || state.serial === this.serial) return;
    this.serial = state.serial;
    void this.register(state.mac.id, true);
  }

  private registerShown(mayAsk = false): Promise<void> {
    const state = this.deps.link.getState();
    return state.kind === "connected" ? this.register(state.mac.id, mayAsk) : Promise.resolve();
  }

  private async register(macId: string, mayAsk: boolean): Promise<void> {
    await this.ready;
    const registration = registrationFor(this.state.prefs, this.state.permission, this.token, this.environment);
    // Alerts are wanted but this launch's token has not come yet: the Mac keeps what an earlier launch registered.
    if (!registration && this.state.prefs.choice !== "off" && this.state.permission === "granted") return void (this.awaitingToken = true);
    let sender: MacSender;
    try {
      // Unregistered, this phone names no host, so the Mac answers for both and this build reads its own.
      sender = (await this.deps.link.connection.device("push.register", { registration }))[this.environment];
    } catch (error) {
      // A dropped session or a slow Mac says nothing about what it can do; an older Mac does not know the method.
      if (!(error instanceof Error && error.message === NOT_FROM_PHONE)) return;
      sender = "update";
    }
    this.update({ senders: new Map(this.state.senders).set(macId, sender) });
    if (!mayAsk || sender !== "ready" || this.state.permission !== "undetermined" || this.asked) return;
    if ((await this.ask()) === "granted") await this.registerShown();
  }

  private setPrefs(prefs: AlertPrefs): void {
    this.update({ prefs });
    this.save();
  }

  private save(): void {
    this.deps.storage.set(KEY, JSON.stringify({ ...this.state.prefs, asked: this.asked }));
  }

  private update(change: Partial<AlertsState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
}
