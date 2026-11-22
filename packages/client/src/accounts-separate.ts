/** Why a Claude account can't change while accounts are kept separate, as the desktop and the phone both say it. */
export const KEPT_SEPARATE = {
  conversation: "Accounts are kept separate, so this conversation stays on its account.",
  orcling: "Accounts are kept separate, so an Orcling stays on its account.",
  subthread: "Accounts are kept separate, so a subthread stays on its thread's account.",
} as const;
