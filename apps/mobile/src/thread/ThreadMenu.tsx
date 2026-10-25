import { Link, Stack } from "expo-router";
import type { ReactElement } from "react";
import { PanelButtonView, type PanelButton } from "./PanelButton";
import type { ThreadAction } from "./thread-actions";

type Run = (action: ThreadAction) => void;

/*
 * A thread's menu as native menus. Both menu kinds read only their own item elements as children, so these are
 * functions that return the elements rather than components.
 */

function linkItems(actions: ThreadAction[], run: Run): ReactElement[] {
  return actions.map((action) =>
    action.kind === "menu" ? (
      <Link.Menu key={action.label} title={action.label} icon={action.icon}>
        {linkItems(action.actions, run)}
      </Link.Menu>
    ) : (
      <Link.MenuAction key={action.label} icon={action.icon} onPress={() => run(action)}>
        {action.label}
      </Link.MenuAction>
    ),
  );
}

/** The long-press menu of a Home row: the thread's title and details over its sections. */
export function rowMenu(sections: ThreadAction[][], run: Run, { title, subtitle }: { title: string; subtitle: string }): ReactElement {
  return (
    <Link.Menu title={title} subtitle={subtitle}>
      {sections.map((section, index) => (
        <Link.Menu key={index} inline>
          {linkItems(section, run)}
        </Link.Menu>
      ))}
    </Link.Menu>
  );
}

function toolbarItems(actions: ThreadAction[], run: Run): ReactElement[] {
  return actions.map((action) =>
    action.kind === "menu" ? (
      <Stack.Toolbar.Menu key={action.label} title={action.label} icon={action.icon}>
        {toolbarItems(action.actions, run)}
      </Stack.Toolbar.Menu>
    ) : (
      <Stack.Toolbar.MenuAction key={action.label} icon={action.icon} onPress={() => run(action)}>
        {action.label}
      </Stack.Toolbar.MenuAction>
    ),
  );
}

function panelButton(button: PanelButton): ReactElement {
  return (
    <Stack.Toolbar.View>
      <PanelButtonView {...button} />
    </Stack.Toolbar.View>
  );
}

/** The open thread's header trailing corner: the side panel's button, when the thread has one, then the More menu. */
export function headerMenu(sections: ThreadAction[][], run: Run, panel: PanelButton | null): ReactElement {
  return (
    <Stack.Toolbar placement="right">
      {panel ? panelButton(panel) : null}
      <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="More">
        {sections.map((section, index) => (
          <Stack.Toolbar.Menu key={index} inline>
            {toolbarItems(section, run)}
          </Stack.Toolbar.Menu>
        ))}
      </Stack.Toolbar.Menu>
    </Stack.Toolbar>
  );
}
