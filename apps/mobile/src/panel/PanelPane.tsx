import { useMemo, type ComponentType } from "react";
import { View } from "react-native";
import { ChangesScreen } from "../changes/ChangesScreen";
import { CloudChangesScreen } from "../changes/CloudChangesScreen";
import { CloudDiffScreen } from "../changes/CloudDiffScreen";
import { DiffScreen } from "../changes/DiffScreen";
import { FileScreen } from "../files/FileScreen";
import { FilesScreen } from "../files/FilesScreen";
import { PreviewScreen } from "../preview/PreviewScreen";
import { SubthreadsScreen } from "../thread/SubthreadsScreen";
import { cn } from "../ui/cn";
import { Pane } from "../ui/pane";
import { PaneScreenContext } from "./host";
import type { PanelName, PanelRoute } from "./pane";

/** Each panel screen, the one its route shows in the stack. */
const screens: Record<PanelName, ComponentType> = {
  changes: ChangesScreen,
  "cloud-changes": CloudChangesScreen,
  diff: DiffScreen,
  "cloud-diff": CloudDiffScreen,
  files: FilesScreen,
  file: FileScreen,
  preview: PreviewScreen,
  subthreads: SubthreadsScreen,
};

/** One of the pane's screens. Those under the one in front keep their place, out of sight, for the way back. */
function PaneRoute({ route, first, front }: { route: PanelRoute; first: boolean; front: boolean }) {
  const Screen = screens[route.name];
  const screen = useMemo(() => ({ route, first, front }), [route, first, front]);
  return (
    <View className={cn("flex-1", !front && "hidden")}>
      <PaneScreenContext.Provider value={screen}>
        <Screen />
      </PaneScreenContext.Provider>
    </View>
  );
}

/** The thread's side panel as a column beside it, `width` wide: the screens the thread's menu opens, under their own bar. */
export function PanelPane({ routes, width }: { routes: readonly PanelRoute[]; width: number }) {
  return (
    <Pane width={width} style={{ width }} className="border-l border-line bg-bg">
      {routes.map((route, index) => (
        <PaneRoute key={`${index}:${route.name}`} route={route} first={index === 0} front={index === routes.length - 1} />
      ))}
    </Pane>
  );
}
