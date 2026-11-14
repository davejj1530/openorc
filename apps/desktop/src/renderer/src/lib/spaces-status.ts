import { useEffect } from "react";
import { invalidateTags, queryClient, useRpc } from "./client";
import { core } from "./rpc";

/** Focus and a quiet periodic read recover missed events without selecting a space. */
export function useSpacesStatus() {
  const read = useRpc("spaces.status", {});
  const account = read.data?.state === "ready" ? read.data.userId : read.data?.state;
  useEffect(() => {
    if (!account || account === "signed-out" || account === "unavailable") return;
    let active = true;
    let reading = false;
    const refresh = async () => {
      if (reading || document.visibilityState === "hidden") return;
      reading = true;
      try {
        const status = await core.call("spaces.refresh", {});
        if (active) {
          queryClient.setQueryData(["spaces.status", {}], status);
          invalidateTags(["spaces", "projects", "threads"], { immediate: true });
        }
      } finally {
        reading = false;
      }
    };
    const reread = () => void refresh().catch(() => {});
    const timer = setInterval(reread, 30_000);
    window.addEventListener("focus", reread);
    window.addEventListener("online", reread);
    document.addEventListener("visibilitychange", reread);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", reread);
      window.removeEventListener("online", reread);
      document.removeEventListener("visibilitychange", reread);
    };
  }, [account]);
  return read;
}
