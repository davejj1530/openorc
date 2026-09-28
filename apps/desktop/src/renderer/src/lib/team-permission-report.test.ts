import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { refreshTeamPermissionReport } from "./team-permission-report";

function fixture() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const queryKey = ["orchestration.runtime", { threadId: "thread" }];
  const calls: { resolve: (value: string) => void; reject: (error: Error) => void }[] = [];
  client.setQueryData(queryKey, "cached Review, no new writer");
  const observer = new QueryObserver(client, { queryKey, queryFn: () => new Promise<string>((resolve, reject) => calls.push({ resolve, reject })) });
  const unsubscribe = observer.subscribe(() => {});
  return {
    client,
    queryKey,
    calls,
    close: () => {
      unsubscribe();
      client.clear();
    },
  };
}
const drain = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("post-save permission report", () => {
  it("waits for a post-save network response through repeated approval invalidations", async () => {
    const f = fixture();
    try {
      // An older cache refresh began before Review→Autonomous→Review finished.
      void f.client.refetchQueries({ queryKey: f.queryKey });
      const guarded = refreshTeamPermissionReport(f.client, "thread");
      let result = "pending";
      void guarded.then(
        () => {
          result = "confirmed";
        },
        () => {
          result = "failed";
        },
      );
      expect(f.calls).toHaveLength(2);
      void f.client.invalidateQueries({ queryKey: f.queryKey });
      await drain();
      void f.client.invalidateQueries({ queryKey: f.queryKey });
      await drain();
      expect(f.calls).toHaveLength(4);
      // Cancelled responses must not release the UI's freshness fence.
      for (const call of f.calls.slice(0, 3)) call.resolve("cached Review, no new writer");
      await drain();
      expect(result).toBe("pending");
      f.client.setQueryData(f.queryKey, "manually restored Review cache");
      await drain();
      expect(result).toBe("pending");
      f.calls[3]!.resolve("Review requested, new Autonomous writer still pending");
      await guarded;
      expect(result).toBe("confirmed");
      expect(f.client.getQueryData(f.queryKey)).toBe("Review requested, new Autonomous writer still pending");
    } finally {
      f.close();
    }
  });

  it("reports a real post-save read failure instead of accepting cached permissions", async () => {
    const f = fixture();
    try {
      const guarded = refreshTeamPermissionReport(f.client, "thread");
      const failure = expect(guarded).rejects.toThrow("Core read failed");
      f.calls[0]!.reject(new Error("Core read failed"));
      await failure;
      expect(f.client.getQueryData(f.queryKey)).toBe("cached Review, no new writer");
    } finally {
      f.close();
    }
  });

  it("releases its subscription if the conversation query is removed", async () => {
    const f = fixture();
    try {
      const guarded = refreshTeamPermissionReport(f.client, "thread");
      const failure = expect(guarded).rejects.toThrow("Team activity was removed");
      f.client.removeQueries({ queryKey: f.queryKey });
      await failure;
    } finally {
      f.close();
    }
  });
});
