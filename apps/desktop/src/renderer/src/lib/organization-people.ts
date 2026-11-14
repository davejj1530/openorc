import { useRpc, useRpcs } from "./client";

/** Each page remains scoped in the query cache and shares the organization's invalidation tag. */
export function useOrganizationPeople(spaceId: string) {
  const first = useRpc("organization.people", { spaceId, offset: 0, limit: 100 });
  const count = Math.max(0, Math.ceil((first.data?.total ?? 0) / 100) - 1);
  const rest = useRpcs(
    "organization.people",
    Array.from({ length: count }, (_, index) => ({ spaceId, offset: (index + 1) * 100, limit: 100 })),
  );
  const pages = [first, ...rest];
  const data = first.data;
  return {
    data: data ? { ...data, members: pages.flatMap((page) => page.data?.members ?? []) } : undefined,
    loading: pages.some((page) => page.isPending),
    error: pages.find((page) => page.error)?.error ?? null,
    refetch: async () => {
      await Promise.all(pages.map((page) => page.refetch()));
    },
  };
}
