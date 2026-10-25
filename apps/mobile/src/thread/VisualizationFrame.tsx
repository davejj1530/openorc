import { visualizationColors, visualizationContextScript, visualizationDocument, visualizationFrameHeight, type VisualizationContext } from "@openorc/client";
import { useEffect, useMemo, useRef, useState, type ComponentProps, type ComponentRef } from "react";
import { useWindowDimensions, View } from "react-native";
import { WebView } from "react-native-webview";
import { fonts } from "../generated/tokens";
import { useColors, useMode } from "../ui/mode";
import { Text } from "../ui/Text";
import { countMount } from "./perf-probe";
import { FIRST_HEIGHT, FRAME_BASE, frameStep, loadGuard, readFrameMessage, type FrameMemory, type FrameState } from "./visualization-frame";

type WebViewProps = ComponentProps<typeof WebView>;
type PageMessage = Parameters<NonNullable<WebViewProps["onMessage"]>>[0];

/**
 * The interface face first, as the desktop hands its own. Neither host's page can reach an app's own face (the
 * desktop's is a web font of its window, the phone's is registered with the app), so both draw the system face.
 */
const FONT = `"${fonts.text}", -apple-system, system-ui, sans-serif`;

/** The phone's palette in the page, read the way the desktop reads its own, and its text at the reader's Text Size. */
function useFrameContext(): VisualizationContext {
  const theme = useMode();
  const palette = useColors();
  const { fontScale } = useWindowDimensions();
  return useMemo(() => ({ theme, font: FONT, colors: visualizationColors((token) => palette[token]), textScale: fontScale }), [theme, palette, fontScale]);
}

/** A page that has not said it is up by then reads as failed, as on the desktop. */
const LOAD_TIMEOUT_MS = 15_000;
const TIMED_OUT = "This visualization did not finish loading. Try Reset.";
const STOPPED = "This visualization stopped. Try Reset.";

/**
 * The web view as a sandbox. `sandboxed` (our patch of react-native-webview) keeps the page from what its policy
 * cannot: WebRTC, WebKit's preconnects to links (all but those to the phone's own and link-local addresses, which the
 * system never proxies), and native alert, confirm and prompt dialogs. Every load goes to the guard, which takes only
 * the page itself; the default list would hand any address that is not http(s) to the system to open. No cookies,
 * storage or cache outlive the view, no file is readable, no window opens, links never preview, nothing on the page
 * turns into a link, and nothing reaches the camera or microphone. The transcript scrolls, so the view does not: it is
 * as tall as its page.
 */
const SANDBOX = {
  sandboxed: true,
  originWhitelist: ["*"],
  incognito: true,
  cacheEnabled: false,
  sharedCookiesEnabled: false,
  allowFileAccess: false,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  javaScriptCanOpenWindowsAutomatically: false,
  allowsLinkPreview: false,
  dataDetectorTypes: "none",
  mediaCapturePermissionGrantType: "deny",
  allowsAirPlayForMediaPlayback: false,
  allowsPictureInPictureMediaPlayback: false,
  allowsBackForwardNavigationGestures: false,
  autoManageStatusBarEnabled: false,
  scrollEnabled: false,
  bounces: false,
  automaticallyAdjustContentInsets: false,
  contentInsetAdjustmentBehavior: "never",
  showsHorizontalScrollIndicator: false,
  showsVerticalScrollIndicator: false,
} as const satisfies WebViewProps;

/** A request to open a window goes nowhere: no new view, and the page stays where it is. */
const openNothing = () => undefined;

/** Whether WebKit has started a page in this app session; the first one costs the most (see `WebKitWarmUp`). */
let webKitStarted = false;
const WARM_UP_PAGE = { html: "", baseUrl: FRAME_BASE };
const unseen = { position: "absolute", width: 1, height: 1, opacity: 0 } as const;

/**
 * WebKit's first page in an app session holds the UI thread for about a tenth of a second (it loads its libraries and
 * starts its network process), more than a pause in scrolling hides. A thread that may show visualizations has it
 * start on a hidden empty page in the same sandbox while its list rests, once per session, so the first visualization
 * a reader stops at starts as cheaply as any other.
 */
export function WebKitWarmUp() {
  const [warming, setWarming] = useState(!webKitStarted);
  const [guard] = useState(loadGuard);
  useEffect(() => {
    webKitStarted = true;
  }, []);
  if (!warming) return null;
  return (
    <View pointerEvents="none" style={unseen}>
      <WebView {...SANDBOX} source={WARM_UP_PAGE} onShouldStartLoadWithRequest={guard} onOpenWindow={openNothing} onLoadEnd={() => setWarming(false)} />
    </View>
  );
}

interface FrameProps {
  title: string;
  html: string;
  /**
   * On screen. A web view off screen sits outside the window (the list clips rows it does not show), where WebKit may
   * hold its page back, so the page's time to come up counts only while it is shown.
   */
  shown: boolean;
  /** What the frame showed when it was last here, so a visualization that comes back takes the space it had. */
  kept: FrameMemory | undefined;
  /** What the frame shows now, for the row to keep once it has no web view. */
  onKeep: (memory: FrameMemory) => void;
}

/** The line a visualization that cannot render shows in its frame's place, the description above it standing in. */
export function FrameFailure({ message }: { message: string }) {
  return <Text className="my-2 text-xs text-ink-3">{`Visualization unavailable: ${message}`}</Text>;
}

/**
 * One visualization's frame. A page that failed when it was last here comes back as its quiet line, with no web view,
 * until Reset asks for a fresh one; anything else gets its page.
 */
export function VisualizationFrame(props: FrameProps) {
  const [failed] = useState(props.kept?.kind === "failed" ? props.kept.message : undefined);
  return failed === undefined ? <FramePage {...props} /> : <FrameFailure message={failed} />;
}

/**
 * The page in a web view: hidden while it loads, as tall as the page says, and folded away behind a quiet line when
 * it fails (still in the window, so a page that comes up late shows after all, as on the desktop). Its page and its
 * guard are made once, when it mounts; Reset mounts a new one.
 */
function FramePage({ title, html, shown, kept, onKeep }: FrameProps) {
  const context = useFrameContext();
  const [source] = useState(() => ({ html: visualizationDocument(html, { host: "react-native", context }), baseUrl: FRAME_BASE }));
  const [guard] = useState(loadGuard);
  const view = useRef<ComponentRef<typeof WebView>>(null);
  const [state, setState] = useState<FrameState>({ kind: "loading" });
  const [height, setHeight] = useState(kept?.kind === "page" ? kept.height : FIRST_HEIGHT);

  useEffect(() => {
    webKitStarted = true;
    countMount("frame");
  }, []);
  const loading = state.kind === "loading";
  useEffect(() => {
    if (!loading || !shown) return;
    const timer = setTimeout(() => setState({ kind: "error", message: TIMED_OUT }), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [loading, shown]);
  // Once the page is up, and whenever the phone's appearance or text size changes, the page takes them.
  useEffect(() => {
    if (!loading) view.current?.injectJavaScript(visualizationContextScript(context));
  }, [loading, context]);
  // A page keeps the room it drew in, a failed one only its line, so the row holds that space without a web view.
  useEffect(() => {
    if (state.kind === "error") onKeep({ kind: "failed", message: state.message });
    else if (state.kind === "ready") onKeep({ kind: "page", height });
  }, [state, height, onKeep]);

  const receive = ({ nativeEvent }: PageMessage) => {
    const message = readFrameMessage(nativeEvent.data);
    if (message?.method === "ui/notifications/size-changed") setHeight(visualizationFrameHeight(message.params.height));
    else if (message) setState((now) => frameStep(now, message));
  };

  return (
    <View>
      {state.kind === "error" ? <FrameFailure message={state.message} /> : null}
      <WebView
        ref={view}
        {...SANDBOX}
        source={source}
        onShouldStartLoadWithRequest={guard}
        onOpenWindow={openNothing}
        onMessage={receive}
        onError={({ nativeEvent }) => setState((now) => (now.kind === "loading" ? { kind: "error", message: nativeEvent.description } : now))}
        onContentProcessDidTerminate={() => setState({ kind: "error", message: STOPPED })}
        accessibilityLabel={title}
        containerStyle={{ flex: 0, height: state.kind === "error" ? 0 : height }}
        style={{ backgroundColor: "transparent", opacity: loading ? 0 : 1 }}
      />
      {/* Over the frame's space rather than above it, so a frame that comes back in view does not move the list. */}
      {loading ? <Text className="absolute left-0 top-2 text-xs text-ink-3">Loading visualization…</Text> : null}
    </View>
  );
}
