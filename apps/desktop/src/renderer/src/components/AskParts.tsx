import { type ReactNode } from "react";
import { Button } from "./ui";

/**
 * A waiting ask's top line: what it asks, where the keyboard enters it, then how many more wait, and last its one quiet
 * way out ("Decline" or "Deny").
 */
export function AskTop({ mark, more, count, children, way }: { mark: ReactNode; more: number; count?: string | undefined; children: ReactNode; way: ReactNode }) {
  return (
    <div className="composer-ask-top">
      <span className="composer-ask-head" tabIndex={-1} data-ask-control="head">
        {mark}
        <span className="min-w-0">{children}</span>
      </span>
      <span className="composer-ask-end">
        {count ? <span className="composer-ask-count tabular">{count}</span> : null}
        {more > 0 ? <span className="composer-ask-count tabular">{more === 1 ? "1 more waits" : `${more} more wait`}</span> : null}
        {way}
      </span>
    </div>
  );
}

/** The quiet way out of an ask, last in the keyboard's walk though it is drawn in the top line. */
export function AskWay({ children, disabled, tip, onClick }: { children: ReactNode; disabled: boolean; tip: string | undefined; onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" tabIndex={-1} data-ask-control="action" data-ask-last="" disabled={disabled} data-tip={tip} onClick={onClick}>
      {children}
    </Button>
  );
}

/**
 * The ask's own line for words: an answer of the person's own, or what to do instead. The words go only when its pill
 * is pressed or Enter is pressed in it; the pill is the column's ink unless the field below holds words.
 */
export function AskLine({
  label,
  placeholder,
  secret,
  value,
  onChange,
  send,
  disabled,
  tip,
}: {
  label: string;
  placeholder: string;
  secret: boolean;
  value: string;
  onChange: (value: string) => void;
  send: { words: string; ink: boolean; onSend: () => void };
  disabled: boolean;
  tip: string | undefined;
}) {
  const typed = value.trim().length > 0;
  return (
    <label className="composer-ask-line" data-ask-line="">
      <input
        type={secret ? "password" : "text"}
        aria-label={label}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        value={value}
        tabIndex={-1}
        disabled={disabled}
        data-tip={tip}
        data-ask-control="line"
        onChange={(event) => onChange(event.target.value)}
      />
      {typed ? (
        <Button size="sm" variant={send.ink ? "primary" : "secondary"} tabIndex={-1} data-ask-send="" disabled={disabled} onClick={send.onSend}>
          {send.words}
        </Button>
      ) : null}
    </label>
  );
}

/** Why the last answer did not go: the ask stays, and can be answered again. */
export function AskError({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="composer-ask-error">
      {error}
    </p>
  ) : null;
}
