import { randomBytes, randomUUID } from "node:crypto";
import { equalBytes, PAIRING_SECRET_BYTES } from "@openorc/link";

const OFFER_MS = 5 * 60_000;
const MAX_MISSES = 5;

export interface PairingOffer {
  offerId: string;
  secret: Uint8Array;
  expiresAt: number;
}

/** At most one open pairing offer: single use, five minutes, burned after five wrong tries. Kept in memory only. */
export class PairingOffers {
  private offer: (PairingOffer & { misses: number }) | null = null;

  /** Replaces any open offer, so only the newest code works. */
  begin(now: number): PairingOffer {
    this.offer = { offerId: randomUUID(), secret: new Uint8Array(randomBytes(PAIRING_SECRET_BYTES)), expiresAt: now + OFFER_MS, misses: 0 };
    return { offerId: this.offer.offerId, secret: this.offer.secret, expiresAt: this.offer.expiresAt };
  }

  open(now: number): { offerId: string; expiresAt: number } | null {
    if (this.offer && this.offer.expiresAt <= now) this.offer = null;
    return this.offer && { offerId: this.offer.offerId, expiresAt: this.offer.expiresAt };
  }

  /** False when no such offer was open. */
  cancel(offerId: string): boolean {
    if (this.offer?.offerId !== offerId) return false;
    this.offer = null;
    return true;
  }

  /** Spends the open offer when both match. Any other try while it is open counts against it. */
  redeem(offerId: string, secret: Uint8Array, now: number): boolean {
    const offer = this.open(now) && this.offer;
    if (!offer) return false;
    if (offer.offerId === offerId && equalBytes(offer.secret, secret)) {
      this.offer = null;
      return true;
    }
    if (++offer.misses >= MAX_MISSES) this.offer = null;
    return false;
  }
}
