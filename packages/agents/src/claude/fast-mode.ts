/**
 * Why Claude Code cannot serve Fast mode, by the reason code it reports on its
 * initialize answer and on init and result lines. Two codes are missing on
 * purpose: `pending` (the account check has not answered yet) and
 * `sdk_opt_in_required` (the session did not ask for Fast). Neither says Fast
 * is off, and codes added later are ignored until they are listed here.
 */
const reasons = new Map<string, string>([
  ["extra_usage_disabled", "Fast mode bills to usage credits, which are turned off for this Claude account. Turn them on in your claude.ai usage settings."],
  ["free", "This Claude plan does not include Fast mode."],
  ["preference", "Fast mode is turned off for this Claude organization."],
  ["not_first_party", "Fast mode requires the Anthropic API or a Claude subscription."],
  ["disabled_by_env", "This Claude Code environment turns Fast mode off."],
  ["model_not_allowed", "This Claude organization's allowed models exclude Fast mode."],
  ["network_error", "Claude Code could not confirm Fast mode access over the network."],
  ["unknown", "Claude reports that Fast mode is unavailable right now."],
]);

/** The reason as a person should read it, or null when the code does not mean Fast is off. */
export function claudeFastModeReason(code: string | null | undefined): string | null {
  return code ? (reasons.get(code) ?? null) : null;
}
