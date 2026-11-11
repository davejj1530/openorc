/** Where the server's answers become the app's shapes. Pure functions, no I/O. */
import type { AccountPlan, CloudHours } from "@openorc/protocol";
import type { WireBilling } from "./wire.js";

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
