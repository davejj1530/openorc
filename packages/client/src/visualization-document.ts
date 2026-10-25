/**
 * The document a visualization runs in, built as text so the desktop's sandbox frame and the phone's web view load
 * the same page. It takes its theme from the host and reports only its size and its errors, never actions.
 */

/**
 * How the document reaches the app showing it: the desktop's sandbox frame posts to its parent window, the phone's
 * web view posts through the bridge React Native puts in the page.
 */
export type VisualizationHost = "frame" | "react-native";

const post: Record<VisualizationHost, string> = {
  frame: "parent.postMessage(message,'*',transfer)",
  "react-native": "window.ReactNativeWebView.postMessage(JSON.stringify(message))",
};

/**
 * What the page hands its host as it comes up. The desktop's frame gets one end of a channel the page keeps the other
 * end of, so the host learns when the page's renderer ends, which a frame never reports itself. The phone's web view
 * reports it.
 */
const lifeline: Record<VisualizationHost, string> = {
  frame: "(()=>{const channel=new MessageChannel();channel.port1.start();return [channel.port2];})()",
  "react-native": "[]",
};

/**
 * What a host's page does with a link. WebKit connects to a link's host as the link is followed, before the phone's
 * guard refuses the load, so the phone's page never follows one; the desktop's frame goes to its sandbox's blocked
 * page, and the row, which hears the page end, shows its quiet line.
 */
const links: Record<VisualizationHost, string> = {
  frame: "",
  "react-native": "addEventListener('click',event=>{if(event.composedPath().some(node=>node instanceof Element&&node.matches('a[href],area[href]')))event.preventDefault();},true);",
};

/** The theme variables a visualization reads, each with the app color it takes. */
const visualizationColorTokens = {
  "--background": "surface",
  "--foreground": "ink",
  "--muted": "ink-3",
  "--border": "line",
  "--accent": "accent",
  "--surface": "surface-2",
} as const;

export type VisualizationColor = keyof typeof visualizationColorTokens;
export type VisualizationColorToken = (typeof visualizationColorTokens)[VisualizationColor];

/** The host's theme as the document applies it. */
export interface VisualizationContext {
  theme: "light" | "dark";
  font: string;
  colors: Record<VisualizationColor, string>;
  /**
   * How much larger than its own sizes the page draws its text: the phone's Text Size, which scales the text of the
   * page as it does the app's, not its layout. The desktop scales the whole frame with its zoom instead.
   */
  textScale?: number;
}

/** The document's colors, read from the host's palette by app color. */
export function visualizationColors(color: (token: VisualizationColorToken) => string): Record<VisualizationColor, string> {
  const entries = Object.entries(visualizationColorTokens) as [VisualizationColor, VisualizationColorToken][];
  return Object.fromEntries(entries.map(([name, token]) => [name, color(token)])) as Record<VisualizationColor, string>;
}

/**
 * Every load a policy governs is refused: inline script and style only, images and media from data: and blob:, no
 * framed address, forms, workers or base URL. The desktop's sandbox also sends it as a header. No policy reaches
 * WebRTC or WebKit's preconnects, so each host keeps the page from the network below it as well: the phone's web view
 * in its native sandbox, the desktop's window through its session (see `McpAppSandbox`).
 */
export const visualizationCsp = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "worker-src 'none'",
].join("; ");

/** How tall a host draws the frame for the height the page reports: never collapsed, never taller than a long screen. */
export const visualizationFrameHeight = (height: number) => Math.min(1200, Math.max(120, height));

const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** WebKit's text size adjustment for a scale, as the page's script sets it too. */
const textSize = (scale: number) => `${Math.round(scale * 100)}%`;

/** The context written into the page, so its first paint is already in the host's theme. */
function themed(context: VisualizationContext | undefined) {
  if (!context) return { html: "", body: "" };
  const variables = Object.entries(context.colors).map(([name, value]) => `${name}:${value}`);
  const text = context.textScale === undefined ? [] : [`-webkit-text-size-adjust:${textSize(context.textScale)}`];
  return {
    html: ` data-theme="${context.theme}" style="${attribute([`color-scheme:${context.theme}`, ...variables, ...text].join(";"))}"`,
    body: ` style="${attribute(`font-family:${context.font}`)}"`,
  };
}

export interface VisualizationDocumentOptions {
  host?: VisualizationHost;
  /** The theme to start in; the host's context message changes it later. */
  context?: VisualizationContext;
}

/** Runs only in a sandbox with an opaque origin. The host accepts sizing and error messages, never actions. */
export function visualizationDocument(html: string, { host = "frame", context }: VisualizationDocumentOptions = {}): string {
  const theme = themed(context);
  return `<!doctype html><html${theme.html}><head><meta http-equiv="Content-Security-Policy" content="${visualizationCsp}"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light;--background:#fff;--foreground:#222;--muted:#666;--border:#ddd;--accent:#245bc1;--surface:#f5f5f5}
*{box-sizing:border-box}html{height:auto;background:var(--background)}body{margin:0;padding:8px 0;color:var(--foreground);background:transparent;font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}
main{display:flow-root;min-width:0}svg,canvas,img{max-width:100%}button,input,select,textarea{font:inherit;color:inherit;max-width:100%;accent-color:var(--accent)}
button,select,textarea,input:not([type=range]):not([type=checkbox]):not([type=radio]){background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:6px 10px}
button{cursor:pointer}button:disabled{opacity:.5;cursor:default}button:hover:not(:disabled){border-color:var(--muted)}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}a{color:var(--accent)}table{border-collapse:collapse;max-width:100%}th,td{padding:6px;text-align:left;border-bottom:1px solid var(--border)}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
</style>
<script>
(() => {
  const send=(method,params={},transfer=[])=>{const message={jsonrpc:'2.0',method,params};${post[host]};};${links[host]}
  let lastHeight=0, scheduled=false, errorMessage='';
  const measure=()=>{
    if(scheduled)return;
    scheduled=true;
    requestAnimationFrame(()=>{
      scheduled=false;
      const height=Math.ceil(document.body.getBoundingClientRect().height);
      if(height!==lastHeight){lastHeight=height;send('ui/notifications/size-changed',{height});}
    });
  };
  addEventListener('message',event=>{
    if(event.source!==parent || event.data?.method!=='openorc/visualization-context')return;
    const context=event.data.params;
    document.documentElement.style.colorScheme=context.theme;
    document.documentElement.dataset.theme=context.theme;
    for(const [name,value] of Object.entries(context.colors))document.documentElement.style.setProperty(name,value);
    document.body.style.fontFamily=context.font;
    if(typeof context.textScale==='number')document.documentElement.style.setProperty('-webkit-text-size-adjust',Math.round(context.textScale*100)+'%');
    measure();
  });
  const report=message=>{errorMessage=String(message).slice(0,500);send('openorc/visualization-error',{message:errorMessage});};
  addEventListener('error',event=>report(event.message || 'The visualization could not load.'));
  addEventListener('unhandledrejection',()=>report('An interaction could not finish.'));
  addEventListener('DOMContentLoaded',()=>{
    send('ui/notifications/initialized',{},${lifeline[host]});
    if(errorMessage)report(errorMessage);
    new ResizeObserver(measure).observe(document.body);
    measure();
  });
})();
</script></head><body${theme.body}><main>${html}</main></body></html>`;
}

/**
 * Hands a web view that is the page itself (no parent frame) the host's context. The event names the page as its
 * source, which is the page's `parent` at the top, so the document takes it as it takes the desktop's message.
 */
export function visualizationContextScript(context: VisualizationContext): string {
  const message = JSON.stringify({ jsonrpc: "2.0", method: "openorc/visualization-context", params: context });
  return `window.dispatchEvent(new MessageEvent('message',{source:window,data:${message}}));true;`;
}
