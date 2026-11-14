import { useEffect } from "react";
import { queryClient } from "./client";
import { organizationContentGate, useOrganizationContentGate } from "./organization-content-gate";
import { protectTaskCache } from "./task-access-cache";

let users = 0;
let disconnect = () => {};
export function useTaskContentGate(spaceId: string | null) {
  useEffect(() => {
    if (++users === 1) disconnect = protectTaskCache(organizationContentGate, queryClient, localStorage);
    return () => {
      if (--users === 0) disconnect();
    };
  }, []);
  return useOrganizationContentGate(spaceId);
}
