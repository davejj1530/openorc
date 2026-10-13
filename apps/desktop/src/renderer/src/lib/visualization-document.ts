/** Runs only in the opaque sandbox frame. The host accepts sizing and error messages, never actions. */
export function visualizationDocument(html: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
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
  const send=(method,params={})=>parent.postMessage({jsonrpc:'2.0',method,params},'*');
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
    measure();
  });
  const report=message=>{errorMessage=String(message).slice(0,500);send('openorc/visualization-error',{message:errorMessage});};
  addEventListener('error',event=>report(event.message || 'The visualization could not load.'));
  addEventListener('unhandledrejection',()=>report('An interaction could not finish.'));
  addEventListener('DOMContentLoaded',()=>{
    send('ui/notifications/initialized');
    if(errorMessage)report(errorMessage);
    new ResizeObserver(measure).observe(document.body);
    measure();
  });
})();
</script></head><body><main>${html}</main></body></html>`;
}

export function visualizationContext() {
  const style = getComputedStyle(document.documentElement);
  return {
    theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
    font: getComputedStyle(document.body).fontFamily,
    colors: {
      "--background": style.getPropertyValue("--surface").trim(),
      "--foreground": style.getPropertyValue("--ink").trim(),
      "--muted": style.getPropertyValue("--ink-3").trim(),
      "--border": style.getPropertyValue("--line").trim(),
      "--accent": style.getPropertyValue("--accent").trim(),
      "--surface": style.getPropertyValue("--surface-2").trim(),
    },
  };
}
