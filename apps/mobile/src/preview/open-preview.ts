import { router } from "expo-router";
import { perfThread } from "../thread/perf-probe";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The Preview performance run's way in: a beat after the thread opened, as a person would take, More, then Preview. */
export async function openPreview(cancelled: () => boolean): Promise<void> {
  await wait(2500);
  const threadId = perfThread();
  if (!threadId || cancelled()) return;
  router.push({ pathname: "/preview", params: { threadId } });
}
