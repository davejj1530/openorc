import { useLayoutEffect, useRef, useState } from "react";
import { useSidebarHistory } from "./sidebar-history";

/** Measure the whole name before moving history, then clip the name at whole words if it cannot fit alone. */
export function useSpaceLabel(label: string, enabled: boolean) {
  const button = useRef<HTMLButtonElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = button.current;
    const text = measure.current;
    if (!element || !text) return;
    const header = element.closest<HTMLElement>(".sidebar-header");
    const fit = () => {
      if (!element.isConnected) return;
      const name = element.querySelector<HTMLElement>(".space-switcher-name");
      const natural = text.getBoundingClientRect().width;
      if (header) {
        const style = getComputedStyle(header);
        const toggle = header.querySelector<HTMLElement>(".sidebar-header-toggle");
        const toggleWidth = toggle?.getBoundingClientRect().width ?? 0;
        const available = header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - (toggleWidth ? toggleWidth + 4 : 0);
        const mark = element.querySelector<HTMLElement>(".organization-invitation-mark")?.getBoundingClientRect().width ?? 20;
        const fits = available >= natural + mark + 21.5 + 52;
        header.dataset.spaceHistory = String(fits);
        useSidebarHistory.setState({ fits });
      }
      setClipped(Boolean(name && natural > name.clientWidth + 0.5));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(header ?? element);
    observer.observe(element);
    observer.observe(text);
    void document.fonts?.ready.then(fit);
    return () => {
      observer.disconnect();
      if (header) {
        delete header.dataset.spaceHistory;
        useSidebarHistory.setState({ fits: true });
      }
    };
  }, [label, enabled]);
  return { button, measure, clipped };
}
