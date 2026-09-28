import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronDown } from "./icons";
import { menuItem, menuPopup } from "./ThreadActions";

/**
 * One branch, chosen from a list with a filter of its own. The button always shows the chosen
 * branch; the filter clears when the list closes, so what you typed never looks like a choice.
 */
export function BranchPicker({ branches, value, onChange, disabled }: { branches: string[]; value: string | null; onChange: (branch: string) => void; disabled?: boolean }) {
  return (
    <Combobox.Root
      items={branches}
      value={value}
      onValueChange={(branch) => {
        if (branch) onChange(branch);
      }}
      disabled={disabled}
      autoHighlight
    >
      <Combobox.Trigger className="native-field flex h-8 min-w-0 items-center gap-2 rounded-md border border-line bg-surface pl-2.5 pr-2 text-left text-base disabled:text-ink-3">
        <span className="min-w-0 flex-1 truncate font-mono">
          <Combobox.Value />
        </span>
        <Combobox.Icon className="shrink-0 text-ink-3">
          <ChevronDown size={14} />
        </Combobox.Icon>
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} align="start">
          <Combobox.Popup aria-label="Branches" className={menuPopup} style={{ width: "var(--anchor-width)" }}>
            <Combobox.Input
              placeholder="Filter branches…"
              className="native-field mb-1 h-7 w-full rounded-md border border-line bg-surface px-2 font-mono text-base placeholder:font-sans placeholder:text-ink-4"
            />
            <Combobox.Empty>
              <p className="px-2 py-1.5 text-sm text-ink-3">No branch matches.</p>
            </Combobox.Empty>
            <Combobox.List>
              {(branch: string) => (
                <Combobox.Item key={branch} value={branch} className={menuItem}>
                  <span className="min-w-0 flex-1 truncate font-mono">{branch}</span>
                  <Combobox.ItemIndicator>
                    <Check size={12} />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
