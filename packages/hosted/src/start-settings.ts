import type { RpcParams } from "@openorc/protocol";

/** The settings a start runs with, as the server names them: its execution target's model, or the fields older callers send. */
export function startSettings(params: Pick<RpcParams<"threads.start">, "agent" | "executionTarget" | "model" | "effort" | "mode" | "permissionMode" | "cloudAccountId">): {
  agent: HostedAgentOrOther;
  model: string | null;
  effort: string | null;
  mode: RpcParams<"threads.start">["mode"];
  permissionMode: RpcParams<"threads.start">["permissionMode"];
  accountId?: string;
} {
  const chosen = params.executionTarget?.kind === "model" ? params.executionTarget.settings : null;
  const agent = chosen?.agent ?? params.agent ?? "claude";
  return {
    agent,
    model: (chosen ? chosen.model : params.model) ?? null,
    effort: (chosen ? chosen.effort : params.effort) ?? null,
    mode: params.mode,
    permissionMode: params.permissionMode,
    ...(params.cloudAccountId && { accountId: params.cloudAccountId }),
  };
}

type HostedAgentOrOther = NonNullable<RpcParams<"threads.start">["agent"]>;
