const KEY = "OPENORC_ACCOUNT_SERVER";

/**
 * The OpenOrc Cloud server a build reaches, given when it is built from outside the repository, so the public code never
 * names it: from the environment the build runs in, and for a development build also from `.env.development.local`
 * (`localFile`). Empty for a build given none.
 */
export function builtAccountServer(mode: string, env: Readonly<Record<string, string | undefined>>, localFile: () => Record<string, string>): string {
  return env[KEY] || (mode === "development" ? localFile()[KEY] : undefined) || "";
}

/** The server the core signs in to: in a development or QA build one named at launch first, else the one built in, else none. */
export function accountServerAt(built: string, qa: boolean, env: Readonly<Record<string, string | undefined>>): string | undefined {
  return (qa ? env[KEY] : undefined) || built || undefined;
}
