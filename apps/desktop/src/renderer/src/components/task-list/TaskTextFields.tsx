type FieldProps = { label: string; value: string; onChange: (value: string) => void; readOnly?: boolean; onBlur?: () => void };

export function TaskTitleField({ label, value, onChange, readOnly, onBlur }: FieldProps) {
  return (
    <textarea
      rows={1}
      aria-label={label}
      className="document-title native-field"
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value.replace(/\n/g, " "))}
      onBlur={onBlur}
    />
  );
}

export function TaskLabelsField({ label, value, onChange, readOnly, onBlur }: FieldProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 mt-6 text-sm text-ink-3">
      <label className="flex min-w-0 flex-1 items-center gap-2">
        <span>Labels</span>
        <input
          aria-label={label}
          className="min-w-0 flex-1 bg-transparent py-1 text-ink-2 placeholder:text-ink-4"
          placeholder="Add labels, comma separated"
          value={value}
          readOnly={readOnly}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
        />
      </label>
    </div>
  );
}
