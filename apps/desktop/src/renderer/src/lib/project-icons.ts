import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export const projectIconKey = (root: string) => ["project-icon", root] as const;

export function useProjectIcon(root: string | undefined) {
  return useQuery({
    queryKey: projectIconKey(root ?? ""),
    queryFn: () => window.openorc.projectIcons.get(root!),
    enabled: Boolean(root && window.openorc?.projectIcons),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}

/** One subscription per sidebar, shared with choosers and any other app windows. */
export function useProjectIconChanges(): void {
  const client = useQueryClient();
  useEffect(() => window.openorc?.projectIcons?.onChanged((root, state) => client.setQueryData(projectIconKey(root), state)), [client]);
}
