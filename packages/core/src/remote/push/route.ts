import type { PushEnvironment } from "@openorc/protocol";

/** One alert, sealed for one phone. A relay gets exactly this and nothing it could read. */
export interface PushDelivery {
  token: string;
  environment: PushEnvironment;
  collapseId: string;
  priority: 5 | 10;
  /** Unix seconds. */
  expiresAt: number;
  /** The APNs JSON, at most 4096 bytes. */
  payload: string;
}

export type PushOutcome =
  | { kind: "sent" }
  /** BadDeviceToken, DeviceTokenNotForTopic, Unregistered, ExpiredToken: forget this token. */
  | { kind: "gone"; reason: string }
  /** The key, team or topic: InvalidProviderToken, MissingProviderToken, BadEnvironmentKeyIdInToken, UnrelatedKeyIdInToken, TopicDisallowed, BadTopic, Forbidden. */
  | { kind: "refused"; reason: string }
  /** 429, 5xx, a second connection failure, anything else: this alert is dropped. */
  | { kind: "failed"; reason: string };

/** Where sealed alerts go: straight to Apple now, through OpenOrc's relay later. Never throws. */
export interface PushRoute {
  send(delivery: PushDelivery): Promise<PushOutcome>;
  close(): void;
}
