import type { ClaudeAccountConnection, ClaudeAccounts } from "@openorc/protocol";

/** Synthetic accounts exercise the real settings and composer without touching credentials. */
export function createDesignClaudeAccountsRpc() {
  const accounts: ClaudeAccounts = {
    defaultId: "claude-cli",
    accounts: [
      { id: "claude-cli", name: "Personal", kind: "cli", enabled: true, createdAt: 0, status: "ready", email: "personal@example.test", organization: null, message: null },
      { id: "work", name: "Work", kind: "managed", enabled: true, createdAt: 1, status: "ready", email: "work@example.test", organization: "Example Company", message: null },
      { id: "client", name: "Client project", kind: "managed", enabled: true, createdAt: 2, status: "signed_out", email: null, organization: null, message: null },
    ],
  };
  return (method: string, params: Record<string, unknown>): unknown => {
    if (method === "claude.accounts.list") return structuredClone(accounts);
    if (method === "claude.accounts.add") {
      const account: ClaudeAccountConnection = {
        id: crypto.randomUUID(),
        name: String(params.name),
        kind: "managed",
        enabled: true,
        createdAt: Date.now(),
        status: "signed_out",
        email: null,
        organization: null,
        message: null,
      };
      accounts.accounts.push(account);
      return account;
    }
    if (method.startsWith("claude.accounts.")) {
      const account = accounts.accounts.find((entry) => entry.id === params.id);
      if (!account) throw new Error("Fixture account not found");
      if (method === "claude.accounts.update") {
        if (typeof params.name === "string") account.name = params.name;
        if (typeof params.enabled === "boolean") {
          account.enabled = params.enabled;
          account.status = params.enabled ? "signed_out" : "disabled";
        }
        if (params.makeDefault) accounts.defaultId = account.id;
        return structuredClone(account);
      }
      if (method === "claude.accounts.login") {
        account.status = "ready";
        account.email = `${account.name.toLowerCase().replace(/\s+/g, "-")}@example.test`;
        return { started: true };
      }
    }
    return undefined;
  };
}
