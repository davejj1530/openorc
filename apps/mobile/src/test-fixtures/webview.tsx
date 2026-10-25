import { createElement, forwardRef, useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { nativeProps, type NativeProps } from "./react-native";

/** The scripts the app handed each web view to run, in order; a test reads them here. */
export const injected = new WeakMap<Element, string[]>();

/**
 * A web view as a DOM element that loads nothing: a test reads the props it was drawn with from `nativeProps`, calls
 * its handlers (onMessage, onShouldStartLoadWithRequest) as the page would, and reads what the app injected.
 */
export const WebView = forwardRef(function WebView(props: NativeProps, ref: Ref<unknown>) {
  const node = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({ injectJavaScript: (script: string) => void injected.set(node.current!, [...(injected.get(node.current!) ?? []), script]) }));
  useLayoutEffect(() => {
    nativeProps.set(node.current!, props);
  });
  return createElement("div", { ref: node, role: "document", "aria-label": props.accessibilityLabel });
});

export default WebView;
