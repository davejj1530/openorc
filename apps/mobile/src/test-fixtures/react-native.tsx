import { createElement, forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, type ReactNode, type Ref } from "react";

/** The props a phone view takes that these DOM stand-ins act on. */
export interface NativeProps {
  children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
  accessibilityLabel?: string;
  accessibilityRole?: string;
  accessibilityState?: { expanded?: boolean; disabled?: boolean };
  disabled?: boolean;
  style?: unknown;
  onPress?: () => void;
  onLayout?: (event: { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } }) => void;
  [prop: string]: unknown;
}

/** The window the views lay out in; a test sets the reader's text size here. */
export const screen = { width: 390, height: 844, scale: 3, fontScale: 1 };

/** Where each view sits in the view `measureLayout` measures against; a test places views here. */
export const placed = { y: (_view: Element): number => 0 };

/** The phone props each element on screen was last drawn with, so a test reads styles and calls handlers. */
export const nativeProps = new WeakMap<Element, NativeProps>();

/** One style object from React Native's nested style arrays. */
export function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatStyle));
  return style && typeof style === "object" ? (style as Record<string, unknown>) : {};
}

/**
 * A host view as a DOM element: it lays out once mounted, measures where `placed` says, and presses on click. A scroll
 * view's `scrollTo` moves nothing, as nothing lays out here.
 */
function host(tag: string) {
  return forwardRef(function Host(props: NativeProps, ref: Ref<unknown>) {
    const node = useRef<HTMLElement>(null);
    useImperativeHandle(ref, () =>
      Object.assign(node.current!, {
        measureLayout: (_relativeTo: unknown, onSuccess: (x: number, y: number, width: number, height: number) => void) => onSuccess(0, placed.y(node.current!), screen.width, 0),
        scrollTo: () => undefined,
      }),
    );
    useLayoutEffect(() => {
      nativeProps.set(node.current!, props);
    });
    // As on the phone, a view reports its layout once, after the whole tree it mounted in has.
    useEffect(() => nativeProps.get(node.current!)?.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: screen.width, height: screen.height } } }), []);
    const { children, accessibilityLabel, accessibilityRole, accessibilityState, disabled, onPress } = props;
    return createElement(
      tag,
      {
        ref: node,
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        "aria-expanded": accessibilityState?.expanded,
        disabled: tag === "button" ? Boolean(disabled) : undefined,
        onClick: onPress,
      },
      typeof children === "function" ? children({ pressed: false }) : children,
    );
  });
}

export const View = host("div");
export const Text = host("span");
export const Pressable = host("button");
export const ScrollView = host("div");
export const Image = host("img");
export const Modal = host("div");
export const TextInput = host("input");

export const Dimensions = { get: () => screen };
export const useWindowDimensions = () => screen;
export const StyleSheet = { create: <T,>(styles: T) => styles, hairlineWidth: 1 / 3, absoluteFill: {} };
export const AppState = { currentState: "active", addEventListener: () => ({ remove: () => undefined }) };
export const Settings = { get: () => undefined };
export const Platform = { OS: "ios", select: <T,>(options: { ios?: T; default?: T }) => options.ios ?? options.default };

/** An action sheet answers at once with its first option, as if the person tapped it. */
export const ActionSheetIOS = { showActionSheetWithOptions: (_options: unknown, onChoice: (index: number) => void) => onChoice(0) };
