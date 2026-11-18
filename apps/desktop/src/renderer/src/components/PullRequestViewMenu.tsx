import { useState } from "react";
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronDown, Plus, Star, Trash2 } from "./icons";
import { menuItem, menuItemDanger, menuPopup, menuSeparator } from "./menu";
import { Button, Checkbox, Dialog, Field, Input, TextButton } from "./ui";
import { CoversPreview } from "../lib/browser-preview";
import { cn } from "../lib/cn";
import { VIEW_NAME_LIMIT, suggestedViewName, type PullRequestListState, type PullRequestView } from "../lib/pull-requests";
import { floatingGround } from "../lib/use-anchor-ground";

/** Names a new view, starting from who and what the list is narrowed to. Saving under a name in use replaces that view. */
export function SaveViewDialog({ state, onSave, onClose }: { state: PullRequestListState; onSave: (name: string, makeDefault: boolean) => void; onClose: () => void }) {
  const [name, setName] = useState(() => suggestedViewName(state));
  const [makeDefault, setMakeDefault] = useState(false);
  const trimmed = name.trim();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title="Save view" width={400}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed) onSave(trimmed, makeDefault);
        }}
      >
        <Field label="Name" hint="Saving under a name you already use replaces that view.">
          <Input autoFocus value={name} maxLength={VIEW_NAME_LIMIT} onChange={(event) => setName(event.target.value)} />
        </Field>
        <label className="mb-4 flex items-center gap-2 text-base text-ink-2">
          <Checkbox checked={makeDefault} onChange={(event) => setMakeDefault(event.target.checked)} />
          Open pull requests with this view
        </label>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!trimmed}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DefaultStar() {
  return (
    <>
      <Star size={12} className="pull-default-star shrink-0" />
      <span className="sr-only">(default)</span>
    </>
  );
}

/**
 * The title's view switcher, as in "Pull requests / ★ Bug squad": the built-in views and yours, the one showing
 * checked, the default starred. Its menu saves the list as a new view, makes the view showing the one the page opens
 * with, and deletes a view of yours. A list whose filters left its view says so beside the name.
 */
export function PullRequestViewMenu({
  views,
  shown,
  edited,
  defaultId,
  onApply,
  onSaveNew,
  onDefault,
  onDelete,
}: {
  views: readonly PullRequestView[];
  /** The view the title names: the one showing, or the one the list was opened as while it's edited. */
  shown: PullRequestView;
  edited: boolean;
  defaultId: string | null;
  onApply: (view: PullRequestView) => void;
  onSaveNew: () => void;
  onDefault: (id: string | null) => void;
  onDelete: (view: PullRequestView) => void;
}) {
  const builtIn = views.filter((view) => view.builtIn);
  const yours = views.filter((view) => !view.builtIn);
  const isDefault = shown.id === defaultId;
  const row = (view: PullRequestView) => (
    <Menu.RadioItem key={view.id} value={view.id} className={menuItem} closeOnClick>
      <Check size={13} className={cn("shrink-0 text-transparent", !edited && view.id === shown.id && "text-ink")} />
      <span className="min-w-0 flex-1 truncate">{view.name}</span>
      {view.id === defaultId ? <DefaultStar /> : null}
    </Menu.RadioItem>
  );
  return (
    <span className="pull-crumbs">
      <span className="pull-crumb-root">Pull requests</span>
      <span aria-hidden="true" className="title-crumb-divider">
        /
      </span>
      <Menu.Root>
        <Menu.Trigger className="pull-crumb no-drag" aria-label={`View: ${shown.name}${isDefault ? ", default" : ""}${edited ? ", edited" : ""}`}>
          {isDefault ? <DefaultStar /> : null}
          <span className="min-w-0 truncate">{shown.name}</span>
          <ChevronDown size={13} className="shrink-0 text-ink-4" />
        </Menu.Trigger>
        <Menu.Portal>
          <CoversPreview />
          <Menu.Positioner sideOffset={6} align="start" className="z-40" collisionPadding={8}>
            <Menu.Popup ref={floatingGround} className={cn(menuPopup, "pull-view-menu")}>
              <Menu.RadioGroup
                aria-label="Views"
                value={edited ? "" : shown.id}
                onValueChange={(id: string) => {
                  const view = views.find((entry) => entry.id === id);
                  if (view) onApply(view);
                }}
              >
                {builtIn.map(row)}
                {yours.length ? (
                  <Menu.Group aria-label="Your views">
                    <Menu.Separator className={menuSeparator} />
                    <Menu.GroupLabel className="menu-empty py-1">Your views</Menu.GroupLabel>
                    {yours.map(row)}
                  </Menu.Group>
                ) : null}
              </Menu.RadioGroup>
              <Menu.Separator className={menuSeparator} />
              <Menu.Item className={menuItem} onClick={onSaveNew}>
                <Plus size={13} className="shrink-0" />
                Save as a new view…
              </Menu.Item>
              <Menu.Item className={menuItem} onClick={() => onDefault(isDefault ? null : shown.id)}>
                <Star size={13} className={cn("shrink-0", isDefault && "pull-default-star")} />
                {isDefault ? `Stop opening with “${shown.name}”` : `Open pull requests with “${shown.name}”`}
              </Menu.Item>
              {shown.builtIn ? null : (
                <Menu.Item className={menuItemDanger} onClick={() => onDelete(shown)}>
                  <Trash2 size={13} className="shrink-0" />
                  Delete “{shown.name}”
                </Menu.Item>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {edited ? <span className="pull-edited">Edited</span> : null}
    </span>
  );
}

/** Beside an edited view: put its filters back, or keep them, over a view of yours or as a new one over a built-in. */
export function PullRequestEditActions({ shown, onRevert, onSave, onSaveNew }: { shown: PullRequestView; onRevert: () => void; onSave: () => void; onSaveNew: () => void }) {
  return (
    <span className="flex items-center gap-1">
      <TextButton tone="muted" className="h-7 px-2 text-sm" onClick={onRevert}>
        Revert
      </TextButton>
      {shown.builtIn ? (
        <Button size="sm" variant="primary" onClick={onSaveNew}>
          Save as view…
        </Button>
      ) : (
        <Button size="sm" variant="primary" onClick={onSave}>
          Save
        </Button>
      )}
    </span>
  );
}
