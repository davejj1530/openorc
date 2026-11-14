import { planLine } from "@openorc/client";
import type { AccountStatus } from "@openorc/protocol";
import { cloneElement } from "react";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { useRpc, useRpcMutation } from "../lib/client";
import { useRouter } from "../lib/router";
import { useAccountSeatState } from "../lib/account-seat-state";
import { AccountGraceLine } from "./AccountGraceLine";
import { AccountFace } from "./AccountFace";
import { CircleUser, LoaderCircle, X } from "./icons";
import { Tooltip } from "./ui";

/**
 * The person at the foot's start. Signed in: their face, name and plan, opening Settings > Account; in a narrow sidebar
 * the name gives way a whole word at a time from its end, and the plan line always fits. Signed out: Sign in. Nothing
 * in a build with no account server to sign in to.
 */
export function SidebarAccount() {
  const { account, now } = useAccountSeatState(useRpc("account.status", {}).data);
  const open = useRouter((s) => s.route.view === "settings" && s.route.section === "account");
  if (account?.state === "signed-out") return <SidebarSignIn account={account} />;
  if (account?.state !== "signed-in") return null;
  const name = account.name ?? account.email;
  return (
    <button
      type="button"
      className="sidebar-account no-drag"
      data-grace={account.organizationAccess?.state === "grace" || undefined}
      aria-current={open ? "page" : undefined}
      onClick={() => {
        useRouter.getState().navigate({ view: "settings", section: "account" });
        dismissCompactNavigation();
      }}
    >
      <AccountFace name={name} image={account.image} className="sidebar-account-face" />
      <span className="sidebar-account-words">
        <span className="sidebar-account-name">
          {name.split(/\s+/).map((word, index) => (
            <span key={index}>{index ? ` ${word}` : word}</span>
          ))}
        </span>
        <span className="sidebar-account-plan">{account.organizationAccess?.state === "grace" ? <AccountGraceLine until={account.organizationAccess.until} now={now} /> : planLine(account)}</span>
      </span>
    </button>
  );
}

/**
 * Sign in opens OpenOrc's sign-in page in the browser. While the page waits the control says so and opens the page
 * again when pressed; its glyph turns, and is the way to call the sign-in off, a cross under the pointer. A sign-in
 * that failed says why under Sign in, cut to the foot's width with the whole of it on hover.
 */
function SidebarSignIn({ account }: { account: Extract<AccountStatus, { state: "signed-out" }> }) {
  const signIn = useRpcMutation("account.signIn");
  const cancel = useRpcMutation("account.signIn.cancel");
  const work = account.signingIn;
  const waiting = work?.state === "waiting";
  const failed = work?.state === "failed" ? work.error : null;
  const button = <button type="button" className="sidebar-account sidebar-sign-in no-drag" disabled={signIn.isPending} onClick={() => signIn.mutate({})} />;
  const label = (
    <>
      {waiting ? <span className="sidebar-sign-in-glyph" /> : <CircleUser size={16} className="sidebar-sign-in-glyph" />}
      <span className="sidebar-account-words">
        <span className="sidebar-sign-in-label">{waiting ? "Signing in…" : "Sign in"}</span>
        {failed ? <span className="sidebar-sign-in-failed">{failed}</span> : null}
      </span>
    </>
  );
  return (
    <div className="sidebar-sign-in-row">
      {failed ? (
        <Tooltip label={failed} side="top" render={button}>
          {label}
        </Tooltip>
      ) : (
        cloneElement(button, {}, label)
      )}
      {waiting ? (
        <Tooltip label="Cancel" side="top" render={<button type="button" aria-label="Cancel signing in" className="sidebar-sign-in-cancel no-drag" onClick={() => cancel.mutate({})} />}>
          <LoaderCircle size={16} className="sidebar-sign-in-turning" />
          <X size={14} className="sidebar-sign-in-cross" />
        </Tooltip>
      ) : null}
    </div>
  );
}
