import type { OrganizationBillingTransport } from "./organization-billing";
import { core } from "./rpc";

/** Only core opens the payment address and holds the account credentials. */
export const organizationBillingTransport: OrganizationBillingTransport = {
  get: (spaceId) => core.call("organization.billing.get", { spaceId }).catch(billingRefusal),
  offers: (spaceId, seats) => core.call("organization.billing.offers", { spaceId, seats }).catch(billingRefusal),
  open: (spaceId, target) => core.call("organization.billing.open", { spaceId, target }).catch(billingRefusal),
  leave: (spaceId) => core.call("organization.billing.leave", { spaceId }).catch(billingRefusal),
  subscribe: (spaceId, refresh) => {
    const stop = core.onPush((push) => {
      if (push.type === "invalidate" && push.keys.includes(`organization-billing:${spaceId}`)) refresh();
    });
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      stop();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  },
};

function billingRefusal(error: unknown): never {
  if (error instanceof Error && /^unknown method organization\.billing\.(get|offers|open|leave)$/.test(error.message)) throw new Error("Update OpenOrc to manage organization seats.");
  throw error;
}
