/** Where the server's answers become the app's shapes. Pure functions, no I/O. */
import type { AccountPlan, AccountSandbox, CloudHours } from "@openorc/protocol";
import type { WireBilling, WireHostedSettings } from "./wire.js";

/** The plan and the hours left. Free carries no hours; a Pro month not paid for yet carries packs alone. */
export function toPlan(billing: WireBilling): { plan: AccountPlan; hours: CloudHours | null } {
  const { pro } = billing;
  if (pro.status === "free") return { plan: { pro: false }, hours: null };
  const at = Date.parse(pro.standing === "live" ? pro.renewsAt : pro.until);
  const month = billing.monthly && billing.period ? { grantedSeconds: billing.monthly.grantedSeconds, leftSeconds: billing.monthly.leftSeconds, resetsAt: Date.parse(billing.period.endsAt) } : null;
  const packsLeftSeconds = billing.packs.reduce((sum, pack) => sum + pack.leftSeconds, 0);
  return {
    plan: { pro: true, standing: pro.standing, at },
    hours: { leftSeconds: (month?.leftSeconds ?? 0) + packsLeftSeconds, monthly: month, packsLeftSeconds },
  };
}

/** Where cloud threads run, in the server's own names for its services. */
export function toSandbox(settings: WireHostedSettings): AccountSandbox {
  return { chosen: settings.service, fallback: settings.defaultService, services: settings.served.map(({ service, name }) => ({ id: service, name })) };
}

/** A picture a window can draw: only an image held in a data URL, since a window loads nothing from the network. */
export function toImage(image: string | null | undefined): string | null {
  return image && /^data:image\/(png|jpeg|webp);base64,/.test(image) ? image : null;
}
