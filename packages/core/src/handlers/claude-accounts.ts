import type { ClaudeAccountService } from "../services/claude-accounts.js";
import type { Handlers } from "./types.js";

export function createClaudeAccountHandlers(
  accounts: ClaudeAccountService,
): Pick<Handlers, "claude.accounts.list" | "claude.accounts.add" | "claude.accounts.update" | "claude.accounts.login" | "claude.accounts.cancelLogin"> {
  return {
    "claude.accounts.list": ({ refresh }) => accounts.list(refresh),
    "claude.accounts.add": ({ name }) => accounts.add(name),
    "claude.accounts.update": (input) => accounts.update(input),
    "claude.accounts.login": ({ id }) => accounts.login(id),
    "claude.accounts.cancelLogin": ({ id }) => accounts.cancelLogin(id),
  };
}
