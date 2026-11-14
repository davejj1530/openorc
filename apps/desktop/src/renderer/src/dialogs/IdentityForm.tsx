import { useRef, useState, type ReactNode } from "react";
import { Button, Input } from "../components/ui";
import { identityPicture } from "../lib/identity-picture";

interface Props {
  name: string;
  image: string | null;
  mark: ReactNode;
  nameLabel: string;
  pictureLabel: string;
  pictureAction: string;
  pending: boolean;
  unchanged: boolean;
  saved?: string;
  error: string | null;
  action: string;
  working: string;
  setName(name: string): void;
  setImage(image: string | null): void;
  setError(error: string | null): void;
  submit(): Promise<void>;
  close(): void;
}

/** The shared identity sheet: a locally cropped picture, a name and one explicit save. */
export function IdentityForm(props: Props) {
  const { pending, saved, error, name, image } = props;
  const file = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const disabled = pending || Boolean(saved);
  const pick = async (picked: File | undefined) => {
    if (!picked) return;
    setReading(true);
    props.setError(null);
    try {
      props.setImage(await identityPicture(picked));
    } catch (error) {
      props.setError(error instanceof Error ? error.message : "That picture couldn't be read. Pick another PNG, JPEG or WebP.");
    } finally {
      setReading(false);
    }
  };
  return (
    <form
      className="organization-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!reading && !pending && !props.unchanged && name.trim()) void props.submit();
      }}
    >
      <div className="organization-logo-field">
        {props.mark}
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          aria-label={props.pictureLabel}
          disabled={disabled || reading}
          onChange={(event) => {
            void pick(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <Button size="sm" disabled={disabled || reading} onClick={() => file.current?.click()}>
          {reading ? "Reading…" : props.pictureAction}
        </Button>
        {image ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || reading}
            onClick={() => {
              props.setImage(null);
              props.setError(null);
            }}
          >
            Remove
          </Button>
        ) : null}
      </div>
      <label className="organization-label">
        Name
        <Input
          variant="sheet"
          aria-label={props.nameLabel}
          placeholder={props.nameLabel}
          value={name}
          disabled={disabled}
          autoFocus
          onChange={(event) => {
            props.setName(event.target.value);
            props.setError(null);
          }}
          aria-invalid={Boolean(error)}
        />
      </label>
      {saved ? <p>{saved}</p> : null}
      {error ? (
        <p className="organization-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="organization-actions">
        <Button onClick={props.close}>{saved ? "Close" : "Cancel"}</Button>
        <Button type="submit" variant="primary" className="organization-save-action" disabled={!name.trim() || pending || reading || props.unchanged}>
          <span data-tip={props.action}>{pending ? props.working : props.action}</span>
        </Button>
      </div>
    </form>
  );
}
