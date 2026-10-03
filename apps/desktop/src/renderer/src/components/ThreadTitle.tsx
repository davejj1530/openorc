import { useRef, useState } from "react";

/** The thread's name stays in the window toolbar, beside its navigation. */
export function ThreadTitle({ title, editing, onEditingChange, onSave }: { title: string; editing: boolean; onEditingChange: (value: boolean) => void; onSave: (title: string) => void }) {
  return (
    <h1 className="thread-rail-title" aria-label={title}>
      {editing ? (
        <TitleInput title={title} onFinish={() => onEditingChange(false)} onSave={onSave} />
      ) : (
        <button type="button" onClick={() => onEditingChange(true)} title={title} aria-label="Rename thread">
          {title}
        </button>
      )}
    </h1>
  );
}

function TitleInput({ title, onFinish, onSave }: { title: string; onFinish: () => void; onSave: (title: string) => void }) {
  const [value, setValue] = useState(title);
  const finished = useRef(false);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const next = value.trim();
    if (save && next && next !== title) onSave(next);
    onFinish();
  };
  return (
    <input
      autoFocus
      aria-label="Thread title"
      value={value}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || (event.key !== "Enter" && event.key !== "Escape")) return;
        event.preventDefault();
        event.stopPropagation();
        finish(event.key === "Enter");
      }}
    />
  );
}
