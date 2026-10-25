import { createElement, forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, type ReactNode, type Ref } from "react";

/** The props a phone view takes that these DOM stand-ins act on. */
export interface NativeProps {
  children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
  accessibilityLabel?: string;
  accessibilityRole?: string;
  accessibilityState?: { expanded?: boolean; disabled?: boolean };
  accessibilityElementsHidden?: boolean;
  testID?: string;
  disabled?: boolean;
  style?: unknown;
  onPress?: () => void;
  onLayout?: (event: { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } }) => void;
  [prop: string]: unknown;
}

/** The window the views lay out in; a test sets the reader's text size here. */
export const screen = { width: 390, height: 844, scale: 3, fontScale: 1 };

/** Where each view sits in the view `measureLayout` measures against, and how tall it is; a test places views here. */
export const placed = { y: (_view: Element): number => 0, height: (_view: Element): number => 0 };

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
    // Every view measures, held by a ref or not: a focus event's target is the view itself.
    useLayoutEffect(() => {
      nativeProps.set(node.current!, props);
      Object.assign(node.current!, {
        measureLayout: (_relativeTo: unknown, onSuccess: (x: number, y: number, width: number, height: number) => void) =>
          onSuccess(0, placed.y(node.current!), screen.width, placed.height(node.current!)),
        scrollTo: () => undefined,
      });
    });
    useImperativeHandle(ref, () => node.current!);
    // As on the phone, a view reports its layout once, after the whole tree it mounted in has.
    useEffect(() => {
      nativeProps.get(node.current!)?.onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: screen.width, height: screen.height } } });
    }, []);
    const { children, accessibilityLabel, accessibilityRole, accessibilityState, accessibilityElementsHidden, testID, disabled, onPress } = props;
    return createElement(
      tag,
      {
        ref: node,
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        // Hidden from VoiceOver, hidden from queries by role.
        "aria-hidden": accessibilityElementsHidden || undefined,
        "data-testid": testID,
        "aria-expanded": accessibilityState?.expanded,
        "aria-disabled": accessibilityState?.disabled,
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

type AlertButton = { text?: string; style?: string; onPress?: (value?: string) => void };
/** Alerts and prompts the app showed, newest last; a test presses their buttons. */
export const alerts: { title: string; message?: string; buttons?: AlertButton[]; defaultValue?: string }[] = [];
export const Alert = {
  alert: (title: string, message?: string, buttons?: AlertButton[]) => void alerts.push({ title, message, buttons }),
  prompt: (title: string, message?: string, buttons?: AlertButton[], _type?: string, defaultValue?: string) => void alerts.push({ title, message, buttons, defaultValue }),
};

/** What the app said to VoiceOver, in order. */
export const announced: string[] = [];
/** The reader's Reduce Motion: a test calls `set` to turn it on or off while the app runs. */
export const reduceMotion = {
  on: false,
  listeners: new Set<(on: boolean) => void>(),
  set(on: boolean) {
    this.on = on;
    this.listeners.forEach((listener) => listener(on));
  },
};
export const AccessibilityInfo = {
  announceForAccessibility: (text: string) => void announced.push(text),
  isReduceMotionEnabled: async () => reduceMotion.on,
  addEventListener: (_event: "reduceMotionChanged", listener: (on: boolean) => void) => {
    reduceMotion.listeners.add(listener);
    return { remove: () => void reduceMotion.listeners.delete(listener) };
  },
};
export const Dimensions = { get: () => screen };
/** Whether the keyboard is up: a test raises it, and `Keyboard.dismiss` puts it away. */
export const keyboard = { up: false };
export const Keyboard = { dismiss: () => void (keyboard.up = false) };
export const useWindowDimensions = () => screen;
export const StyleSheet = { create: <T,>(styles: T) => styles, hairlineWidth: 1 / 3, absoluteFill: {} };
export const AppState = { currentState: "active", addEventListener: () => ({ remove: () => undefined }) };
export const Settings = { get: () => undefined };
export const Platform = { OS: "ios", select: <T,>(options: { ios?: T; default?: T }) => options.ios ?? options.default };

/** What the app opened outside itself, in order: "settings" for its page in iOS Settings. */
export const opened: string[] = [];
export const Linking = { openSettings: async () => void opened.push("settings") };

/** An action sheet answers at once with its first option, as if the person tapped it. */
export const ActionSheetIOS = { showActionSheetWithOptions: (_options: unknown, onChoice: (index: number) => void) => onChoice(0) };
