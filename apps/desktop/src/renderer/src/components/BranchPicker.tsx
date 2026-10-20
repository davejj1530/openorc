import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronDown, GitBranch } from "./icons";
import { growOffset, menuGrowPopup, menuItem } from "./menu";

/**
 * One branch, chosen from a list with a filter of its own. The pill always shows the chosen
 * branch, and the list grows out of it with the filter where the pill was. The filter clears
 * when the list closes, so what you typed never looks like a choice. It only lives in dialogs and
 * sheets, so it takes the plane's floating fill.
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
      <Combobox.Trigger className="hover-step flex h-9 min-w-0 items-center gap-2 rounded-full bg-control-fill pl-3 pr-2.5 text-left text-base text-ink disabled:text-ink-3">
        <GitBranch size={14} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate font-mono">
          <Combobox.Value />
        </span>
        <Combobox.Icon className="shrink-0 text-ink-4">
          <ChevronDown size={14} />
        </Combobox.Icon>
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={growOffset} align="start" collisionPadding={8}>
          <Combobox.Popup aria-label="Branches" className={menuGrowPopup} data-ground="plane">
            <Combobox.Input placeholder="Filter branches" className="menu-filter native-field font-mono placeholder:font-sans" />
            <Combobox.Empty>
              <p className="menu-empty">No branch matches.</p>
            </Combobox.Empty>
            <Combobox.List>
              {(branch: string) => (
                <Combobox.Item key={branch} value={branch} className={menuItem}>
                  <GitBranch size={14} />
                  <span className="min-w-0 flex-1 truncate font-mono">{branch}</span>
                  <Combobox.ItemIndicator className="flex text-ink">
                    <Check size={14} />
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
