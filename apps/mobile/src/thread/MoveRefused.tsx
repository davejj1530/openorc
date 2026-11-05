import { threadMoveCard } from "@openorc/client";
import type { DeviceRpcResults, ThreadSummary } from "@openorc/protocol";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { hostClient, hostLink } from "../client";
import { cn } from "../ui/cn";
import { Text } from "../ui/Text";
import { useMover } from "./use-mover";

type Refusals = DeviceRpcResults["moves.refused"];

/** The moves the group's Mac asked for that were refused, as it says; none from a Mac before it said. */
function useRefusals(mac: string | null) {
  return useQuery<Refusals>(
    {
      queryKey: ["moves.refused"],
      queryFn: () =>
        hostLink(mac)
          .connection.device("moves.refused", {})
          .catch((): Refusals => []),
      meta: { tags: ["threads"] },
      enabled: mac !== null,
      retry: false,
    },
    hostClient(mac).queryClient,
  );
}

/**
 * Why the move the Mac asked for did not happen, over the conversation, until it is tried again or the conversation
 * does something else. Try again asks the Mac for the same move, as the menu does.
 */
export function MoveRefused({ thread }: { thread: ThreadSummary }) {
  const mac = useMover()?.mac ?? null;
  const refusals = useRefusals(mac);
  const [trying, setTrying] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const refusal = refusals.data?.find((each) => each.threadId === thread.id)?.refusal ?? null;
  const card = threadMoveCard({ ...thread, moveRefused: refusal });
  if (card?.kind !== "refused" || mac === null) return null;
  const retry = () => {
    setTrying(true);
    setFailure(null);
    hostLink(mac)
      .connection.call(card.retry, { threadId: thread.id })
      .then(() => refusals.refetch())
      .catch((error: Error) => setFailure(error.message))
      .finally(() => setTrying(false));
  };
  return (
    <View accessibilityLabel={card.title} className="mx-4 mt-2 gap-2 rounded-3xl bg-surface px-4 pb-4 pt-3.5">
      <Text className="text-md">{card.title}</Text>
      <Text accessibilityRole={failure ? "alert" : undefined} className={cn("text-sm text-ink-3", failure && "text-bad")}>
        {failure ?? card.reason}
      </Text>
      <Pressable accessibilityRole="button" disabled={trying} onPress={retry} className="h-control-md self-start justify-center rounded-full bg-surface-2 px-4 active:bg-surface-3">
        <Text className={cn("text-sm text-ink-2", trying && "text-ink-4")}>Try again</Text>
      </Pressable>
    </View>
  );
}
