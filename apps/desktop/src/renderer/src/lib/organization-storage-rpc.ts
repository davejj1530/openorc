import type { OrganizationStorageTransport } from "../views/OrganizationStorage";
import { organizationBillingTransport } from "./organization-billing-rpc";
import { core } from "./rpc";

export const organizationStorageTransport: OrganizationStorageTransport = {
  get: (spaceId) => core.call("organization.storage.get", { spaceId }),
  subscribe: (spaceId, refresh) => {
    const stopBilling = organizationBillingTransport.subscribe(spaceId, refresh);
    const stopUploads = core.onPush((push) => {
      if (push.type === "invalidate" && push.keys.some((key) => key === "hostedFiles" || key === `team-chat:${spaceId}`)) refresh();
    });
    return () => {
      stopBilling();
      stopUploads();
    };
  },
};
