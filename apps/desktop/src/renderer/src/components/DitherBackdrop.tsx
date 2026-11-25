import { DitheringShapes, DitheringTypes, ShaderFitOptions, ShaderMount, ditheringFragmentShader, getShaderColorFromString, imageDitheringFragmentShader } from "@paper-design/shaders";
import { useEffect, useRef, useState } from "react";
import storm from "../assets/backdrop/rosalie.jpg";
import day from "../assets/backdrop/grassland.jpg";
import { cn } from "../lib/cn";
import { toHex } from "../lib/color";
import { backdropPatterns, isPicture, useBackdrop, type Backdrop, type BackdropPattern } from "../lib/backdrop";
import { observeOnScreen, useReducedMotion } from "../lib/motion";
import { useTheme } from "../lib/theme";
import { paintingCrop, paintingScenes, type PaintingScene, type Pixels } from "@openorc/client/theme";

/** The sphere fills the corner it fades from; the other shapes read at the shader's own scale. */
const SCALE: Partial<Record<BackdropPattern, number>> = { sphere: 2.2 };
const CLEAR = [0, 0, 0, 0] as const;
/** Dots are a CSS pixel or larger, so the shader's default of 2 canvas pixels per CSS pixel buys nothing. */
const PIXEL_RATIO = 1;
/** A full HD frame at most: a larger backdrop draws one canvas pixel for every two CSS pixels across. */
const MAX_PIXELS = 1920 * 1080;

/**
 * The canvas pixels a backdrop of this CSS size draws: one per CSS pixel, or one per two each way past MAX_PIXELS. The
 * shader starts from device pixels and shrinks them to its budget by whatever fraction fits, which puts each dot on two
 * or three canvas pixels and stretches it unevenly, larger as the backdrop widens. A whole step keeps every dot its size.
 */
function pixelBudget(width: number, height: number): number {
  const area = Math.max(1, Math.round(width) * Math.round(height));
  return area <= MAX_PIXELS ? area : Math.ceil(area / 4);
}

const sizing = { u_fit: ShaderFitOptions.cover, u_rotation: 0, u_offsetX: 0, u_offsetY: 0, u_originX: 0.5, u_originY: 0.5, u_worldWidth: 0, u_worldHeight: 0 };

type Ink = ReturnType<typeof getShaderColorFromString>;

/** The dots' ink, from the --dither-ink token the backdrop's styles mix from the palette on screen. */
const inkOf = (element: Element): Ink => getShaderColorFromString(toHex(getComputedStyle(element).getPropertyValue("--dither-ink").trim()) ?? undefined);

/** What the shader is told: the style's own uniforms, the grid and dot size, and the ink. */
function uniforms(backdrop: Backdrop, ink: Ink) {
  const grid = { u_type: DitheringTypes[backdrop.grid], u_pxSize: backdrop.size };
  if (backdrop.style === "image") return { ...grid, u_colorFront: ink, u_colorHighlight: ink, u_colorBack: [...CLEAR], u_originalColors: true, u_inverted: false, u_colorSteps: 2, u_scale: 1 };
  const pattern = backdropPatterns.find(({ id }) => id === backdrop.style)?.id ?? "sphere";
  return { ...grid, u_colorFront: ink, u_colorBack: [...CLEAR], u_shape: DitheringShapes[pattern], u_scale: SCALE[pattern] ?? 1 };
}

/** The image a backdrop dithers, once the window has decoded it; null while it loads, or for a pattern. */
function useDecodedImage(source: string | null): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    setImage(null);
    if (!source) return;
    let current = true;
    const element = new Image();
    element.src = source;
    element
      .decode()
      .then(() => current && setImage(element))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [source]);
  return image;
}

/** Which shader draws the style: none while off, for the painting, or while its image decodes. */
function shaderProgram(style: Backdrop["style"], image: HTMLImageElement | null): "pattern" | "image" | null {
  if (style === "off" || style === "painting") return null;
  if (style === "image") return image ? "image" : null;
  return "pattern";
}

/** What the backdrop's styles key on: the painting, the user's image, or a pattern. */
const styleOf = (style: Backdrop["style"]) => (isPicture(style) ? style : "pattern");

let webgl2: boolean | undefined;

/** Whether the window can run the shader, asked once a session; the probe's context is freed now, not at collection. */
function canDraw(): boolean {
  if (webgl2 === undefined) {
    const probe = typeof WebGL2RenderingContext === "undefined" ? null : document.createElement("canvas").getContext("webgl2");
    webgl2 = probe !== null;
    probe?.getExtension("WEBGL_lose_context")?.loseContext();
  }
  return webgl2;
}

/**
 * Runs a pattern's clock while it is on screen. The shader's own loop draws every display frame, but a slow pattern
 * changes few dots a frame, so this draws as often as the speed needs: 15 frames a second when slow, up to 60.
 */
function animate(mount: ShaderMount, speed: number): () => void {
  // Display frames land a little either side of the interval; one slightly early still counts as due.
  const interval = 900 / Math.max(15, 60 * speed);
  let request = 0;
  let drawn = 0;
  const tick = (now: number) => {
    request = requestAnimationFrame(tick);
    if (now - drawn < interval) return;
    mount.setFrame(mount.getCurrentFrame() + (now - drawn) * speed);
    drawn = now;
  };
  const stop = observeOnScreen(mount.parentElement, (onScreen) => {
    cancelAnimationFrame(request);
    if (!onScreen) return;
    drawn = performance.now();
    request = requestAnimationFrame(tick);
  });
  return () => {
    stop();
    cancelAnimationFrame(request);
  };
}

/** The scenery's dots on the screen, in CSS pixels: whole pixels at every window size keep every dot square. */
const DOT = 2;
/** The least time between two redraws while the window is resized. */
const REDRAW_MS = 150;

/** A picture the screen shows: its source, and the scene the phone draws from the same picture. */
type Scene = PaintingScene & { source: string };

const scenes: Record<"dark" | "light", Scene> = {
  dark: { source: storm, ...paintingScenes.dark },
  light: { source: day, ...paintingScenes.light },
};

/**
 * The picture at one pixel a cell, cropped to the cells' shape around its centre of interest within its reach, as the
 * window draws it smaller. Null where the window gives no 2D canvas.
 */
function fittedPainting(image: HTMLImageElement, scene: Scene, width: number, height: number): Pixels | null {
  const crop = paintingCrop({ width: image.naturalWidth, height: image.naturalHeight }, scene, { width, height });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
  return { data: context.getImageData(0, 0, width, height).data, width, height };
}

/** What a painting canvas holds: its cells across and down, the dot they are drawn at, and the scene. */
interface Drawn {
  width: number;
  height: number;
  dot: number;
  image: HTMLImageElement;
}

/** Draws the scene into the canvas at its frame's size, unless it already holds that picture at that size. */
function paint(canvas: HTMLCanvasElement, image: HTMLImageElement, scene: Scene, dot: number, drawn: { current: Drawn | null }) {
  const frame = canvas.parentElement;
  const next = { width: Math.ceil((frame?.clientWidth ?? 0) / dot), height: Math.ceil((frame?.clientHeight ?? 0) / dot), dot, image };
  const { width, height } = next;
  const held = drawn.current;
  if (!width || !height || (held && held.width === width && held.height === height && held.dot === dot && held.image === image)) return;
  const fitted = fittedPainting(image, scene, width, height);
  const context = canvas.getContext("2d");
  if (!fitted || !context) return;
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width * dot}px`;
  canvas.style.height = `${height * dot}px`;
  context.putImageData(new ImageData(scene.draw(fitted), width, height), 0, 0);
  drawn.current = next;
}

/**
 * The scenery that comes with the app for the theme on screen, dithered on the CPU at the frame's own size: one canvas
 * pixel a dot, scaled up without smoothing. It is drawn again when the frame's size settles, never animated. Only the
 * shown theme's picture loads.
 */
function PaintingCanvas({ dot }: { dot: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = scenes[useTheme((state) => state.resolved)];
  const decoded = useDecodedImage(scene.source);
  // Until the new theme's picture decodes, the last one stays rather than being drawn in the wrong scene's colours.
  const image = decoded?.getAttribute("src") === scene.source ? decoded : null;
  const drawn = useRef<Drawn | null>(null);

  useEffect(() => {
    const element = canvas.current;
    const frame = element?.parentElement;
    if (!element || !frame || !image) return;
    let timer = 0;
    let last = 0;
    const draw = () => {
      timer = 0;
      last = performance.now();
      paint(element, image, scene, dot, drawn);
    };
    draw();
    const observer = new ResizeObserver(() => {
      if (!timer) timer = window.setTimeout(draw, Math.max(0, REDRAW_MS - (performance.now() - last)));
    });
    observer.observe(frame);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [image, scene, dot]);

  return <canvas ref={canvas} />;
}

interface DitherBackdropProps {
  className?: string;
  /** Settings' preview: the picture at half size, so its dots are half size too. */
  miniature?: boolean;
}

/**
 * The backdrop chosen in Settings: the scenery that comes with the app, a pattern from the shader's shapes in the
 * palette's ink on a clear ground that the mask fades out, or the user's image in its own colors, all in ordered dots.
 * It follows the palette and reduced motion; the patterns and the image paint nothing without WebGL2.
 */
export function DitherBackdrop({ className, miniature }: DitherBackdropProps) {
  const backdrop = useBackdrop();
  // The ink comes from the palette's tokens, so any theme change repaints it.
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const frame = useRef<HTMLDivElement>(null);
  const [mount, setMount] = useState<ShaderMount | null>(null);
  const [restored, setRestored] = useState(0);
  const decoded = useDecodedImage(backdrop.style === "image" ? backdrop.image : null);
  const program = shaderProgram(backdrop.style, decoded);
  const image = program === "image" ? decoded : null;
  const speed = backdrop.style === "image" || reducedMotion ? 0 : backdrop.motion / 100;
  const latest = useRef(backdrop);
  latest.current = backdrop;

  // One shader per program, built again when the GPU hands back a lost context; a setting changing only retunes it.
  useEffect(() => {
    const element = frame.current;
    if (!element || !program || !canDraw()) return;
    const shader = program === "image" ? imageDitheringFragmentShader : ditheringFragmentShader;
    const texture = image ? { u_image: image } : {};
    const budget = pixelBudget(element.clientWidth, element.clientHeight);
    const created = new ShaderMount(element, shader, { ...sizing, ...uniforms(latest.current, inkOf(element)), ...texture }, undefined, 0, 0, PIXEL_RATIO, budget);
    const canvas = created.canvasElement;
    // The browser restores a lost context only when its loss is cancelled.
    const lost = (event: Event) => event.preventDefault();
    const restore = () => setRestored((count) => count + 1);
    canvas.addEventListener("webglcontextlost", lost);
    canvas.addEventListener("webglcontextrestored", restore);
    setMount(created);
    return () => {
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restore);
      setMount(null);
      // dispose frees the shader's resources but leaves the context alive until collected.
      const context = canvas.getContext("webgl2");
      created.dispose();
      context?.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [program, image, restored]);

  useEffect(() => {
    if (mount) mount.setUniforms(uniforms(backdrop, inkOf(mount.parentElement)));
  }, [mount, backdrop, theme]);

  useEffect(() => (mount && speed > 0 ? animate(mount, speed) : undefined), [mount, speed]);

  useEffect(() => {
    if (!mount) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) mount.setMaxPixelCount(pixelBudget(entry.contentRect.width, entry.contentRect.height));
    });
    observer.observe(mount.parentElement);
    return () => observer.disconnect();
  }, [mount]);

  return (
    <div ref={frame} aria-hidden="true" data-style={styleOf(backdrop.style)} data-picture={isPicture(backdrop.style) || undefined} className={cn("dither-backdrop", className)}>
      {backdrop.style === "painting" ? <PaintingCanvas dot={miniature ? DOT / 2 : DOT} /> : null}
    </div>
  );
}
