import { panelToolLabels, pageLabel } from "@openorc/client";
import * as Clipboard from "expo-clipboard";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo, type ReactElement } from "react";
import { View } from "react-native";
import { PreviewPage } from "./PreviewPage";
import { useLinkState, useRpc } from "../client";
import { perfEnabled } from "../thread/perf-probe";
import { PanelTitle } from "../changes/PanelTitle";
import { haptic } from "../ui/haptics";
import { Spinner } from "../ui/Spinner";
import { Text } from "../ui/Text";
import { useLate } from "../ui/use-late";
import { openInApp } from "../ui/web";
import { markFrameRender } from "./preview-perf";
import { PreviewPerf } from "./PreviewPerf";
import { previewLine, previewView, refusalWords, safariAddress, type PreviewView } from "./preview-view";
import { usePreview, type PreviewImage } from "./use-preview";
import { usePreviewInput } from "./use-preview-input";

/** A first watch quicker than this shows no spinner at all. */
const SPINNER_DELAY_MS = 300;

/** One quiet line in the middle of the screen, and the Mac's own words beneath it when there are any. */
function Words({ title, detail }: { title: string; detail?: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-1 px-8">
      <Text className="text-center text-md text-ink-3">{title}</Text>
      {detail ? <Text className="text-center text-sm text-ink-4">{detail}</Text> : null}
    </View>
  );
}

function Opening({ connected }: { connected: boolean }) {
  const late = useLate(SPINNER_DELAY_MS);
  return <View className="flex-1 items-center justify-center">{late && connected ? <Spinner /> : null}</View>;
}

interface BodyProps {
  view: PreviewView;
  frame: PreviewImage | null;
  mac: string;
  page: string;
  connected: boolean;
  onZoom: (scale: number, settled: boolean) => void;
  input: ReturnType<typeof usePreviewInput>;
}

function Body({ view, frame, mac, page, connected, onZoom, input }: BodyProps) {
  switch (view.kind) {
    case "opening":
      return <Opening connected={connected} />;
    case "closed":
      return <Words title={`Preview is closed on ${mac}`} />;
    case "refused":
      return <Words title={view.message} />;
    case "loading":
      return <Words title={`Loading ${view.host}…`} />;
    case "failed":
      return <Words title="Could not load the preview" detail={view.message} />;
    case "stopped":
      return <Words title="The preview stopped" detail={`Reload it on ${mac}.`} />;
    case "page":
      return frame ? <PreviewPage frame={frame} label={`${page}, on ${mac}`} page={page} dim={view.dim} onZoom={onZoom} input={input} /> : null;
  }
}

/** The page's own menu: its address to copy, and Safari for a public one, which opens with the phone's own sessions. */
function pageMenu(address: string, safari: string | null): ReactElement {
  const copy = () => void Clipboard.setStringAsync(address).then(() => haptic.tap());
  const items = [
    <Stack.Toolbar.MenuAction key="copy" icon="doc.on.doc" onPress={copy}>
      Copy Address
    </Stack.Toolbar.MenuAction>,
  ];
  if (safari)
    items.push(
      <Stack.Toolbar.MenuAction key="safari" icon="safari" onPress={() => openInApp(safari)}>
        Open in Safari
      </Stack.Toolbar.MenuAction>,
    );
  return (
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="Page">
        {items}
      </Stack.Toolbar.Menu>
    </Stack.Toolbar>
  );
}

/**
 * The Mac's Preview of a thread, live: the tab the agent's browser acts on, as the Mac shows it, to watch, pinch and
 * pan, tap, scroll and type into. Tabs, reload and history stay on the Mac.
 */
export function PreviewScreen() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const preview = usePreview(threadId);
  const input = usePreviewInput(threadId, preview.frame);
  markFrameRender();
  const read = useRpc("preview.state", { threadId });
  const linkState = useLinkState();
  const mac = linkState.kind === "unpaired" ? "your Mac" : linkState.mac.name;
  const { state, frame, connected, active } = preview;
  const view = previewView({ state, refused: preview.refused === null ? null : refusalWords(preview.refused, mac), shown: frame !== null, connected, active });
  // A refused input's words stand in the line for a moment.
  const line = input.notice ?? previewLine(view, state, read.data);
  const page = state?.open ? pageLabel({ url: state.address, title: state.title }) : panelToolLabels.browser;
  // Frames arrive twice a second; the header changes only with its words.
  const options = useMemo(() => ({ headerTitle: () => <PanelTitle title={panelToolLabels.browser} line={line} /> }), [line]);
  const address = state?.open ? state.address : null;
  const safari = safariAddress(state);
  const menu = useMemo(() => (address === null ? null : pageMenu(address, safari)), [address, safari]);
  return (
    <View className="flex-1 bg-bg">
      <Stack.Screen options={options} />
      {menu}
      <Body view={view} frame={frame} mac={mac} page={page} connected={connected} onZoom={preview.onZoom} input={input} />
      {perfEnabled() ? <PreviewPerf shown={frame !== null} /> : null}
    </View>
  );
}
