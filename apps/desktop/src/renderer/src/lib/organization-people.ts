import { useRpc, useRpcs } from "./client";
import { useOrganizationContentGate } from "./organization-content-gate";

/**
 * Each page remains scoped in the query cache and shares the organization's invalidation tag. A frozen admin still reads
 * the people; someone no longer in the organization reads nothing of it.
 */
export function useOrganizationPeople(spaceId: string) {
  const member = useOrganizationContentGate(spaceId).blocked !== "membership";
  const first = useRpc("organization.people", { spaceId, offset: 0, limit: 100 }, { enabled: member });
  const count = Math.max(0, Math.ceil((first.data?.total ?? 0) / 100) - 1);
  const rest = useRpcs("organization.people", member ? Array.from({ length: count }, (_, index) => ({ spaceId, offset: (index + 1) * 100, limit: 100 })) : []);
  const pages = [first, ...rest];
  const data = first.data;
  return {
    data: data ? { ...data, members: pages.flatMap((page) => page.data?.members ?? []) } : undefined,
    loading: pages.some((page) => page.isPending),
    error: pages.find((page) => page.error)?.error ?? null,
    refetch: async () => {
      await Promise.all(pages.map((page) => page.refetch({ throwOnError: true })));
    },
  };
}
