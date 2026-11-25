import { COMMIT_READS } from "@openorc/protocol";
import { createContext, useContext, useMemo } from "react";
import { Keyboard } from "react-native";
import { useRpc, useRpcs } from "../client";
import { useShares } from "../connection/use-shares";
import { pane } from "../panel/pane";
import { commitIds } from "./commit-links";

/** The thread whose commits a reply's ids name: in its folder on the Mac, or in the cloud. */
export interface CommitScope {
  threadId: string;
  cloud: boolean;
}

/** Set where a commit's id in a reply can open that commit: a thread's own transcript. */
export const CommitScopeContext = createContext<CommitScope | null>(null);

const NONE: ReadonlyMap<string, string> = new Map();
const NO_IDS: string[] = [];

/**
 * The ids in a finished reply that name a commit the thread holds, each with the whole id it names. The Mac is asked
 * about each id once; a cloud thread's are found among its own commits. A reply still being written links none.
 */
export function useNamedCommits(text: string, streaming: boolean): ReadonlyMap<string, string> {
  const scope = useContext(CommitScopeContext);
  const ids = useMemo(() => (scope && !streaming ? commitIds(text) : NO_IDS), [scope, streaming, text]);
  const threadId = scope?.threadId ?? "";
  const cloud = scope?.cloud === true;
  const shared = useShares(COMMIT_READS) === true;
  // An id that names no commit is not an error to try again.
  const local = useRpcs("git.threadCommit", cloud || !shared ? [] : ids.map((sha) => ({ threadId, sha })), { retry: false, staleTime: Infinity });
  const listed = useRpc("hosted.review.commits", { threadId }, { enabled: cloud && ids.length > 0, retry: false });
  const found = cloud ? ids.map((id) => listed.data?.commits.find((commit) => commit.sha.startsWith(id))?.sha) : local.map((read) => read.data?.commit.sha);
  // One string for what was found, so the reply is written again only when an id comes to name a commit.
  const shas = found.map((sha) => sha ?? "").join(",");
  return useMemo(() => {
    const named = new Map<string, string>();
    shas.split(",").forEach((sha, index) => {
      const id = ids[index];
      if (sha && id) named.set(id, sha);
    });
    return named.size ? named : NONE;
  }, [ids, shas]);
}

/** Opens one of a thread's commits as its changes, beside the thread or over it. */
export function openCommit({ threadId, cloud }: CommitScope, sha: string): void {
  Keyboard.dismiss();
  pane.open({ name: "commit-changes", params: cloud ? { threadId, sha, cloud: "1" } : { threadId, sha } });
}
