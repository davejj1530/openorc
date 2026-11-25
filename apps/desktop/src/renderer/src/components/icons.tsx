import { forwardRef, type ReactNode, type SVGProps } from "react";

/**
 * OpenOrc's outline family, original geometry on a 24px grid in a 2px line with round ends, which is 1.5px at the
 * sidebar's 18px and the weight of the letters beside it. One idea a glyph, in as few strokes as say it: no inner
 * detail lines and nothing smaller than 3 units, so a glyph holds at 13px. Faces reach the 3 to 21 box, and frames
 * turn their corners at 3.5 or more.
 */
export type IconProps = SVGProps<SVGSVGElement> & { size?: number | string };

function icon(name: string, geometry: ReactNode) {
  const Icon = forwardRef<SVGSVGElement, IconProps>(function PrecisionIcon({ size = 24, className, children, ...props }, ref) {
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        className={className ? `openorc-icon ${className}` : "openorc-icon"}
        data-icon={name}
        {...props}
      >
        {geometry}
        {children}
      </svg>
    );
  });
  Icon.displayName = name;
  return Icon;
}

const frame = <rect x="3.5" y="3.5" width="17" height="17" rx="4" />;
/** A pane's outline, wider than tall as a window is. */
const pane = <rect x="3" y="4.5" width="18" height="15" rx="3.5" />;
const windowFrame = (
  <>
    {pane}
    <path d="M3 9.5h18" />
  </>
);
const paper = <path d="M14 3.5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9Z M14 3.5v6h6" />;
const folder = <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2a2 2 0 0 1 1.5.7l1.5 1.8h6.8A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z" />;
const clockFace = (
  <>
    <circle cx="12" cy="13" r="7.5" />
    <path d="M12 9.5V13l2.5 1.5" />
  </>
);
const lens = (
  <>
    <circle cx="11" cy="11" r="7.5" />
    <path d="m16.5 16.5 4 4" />
  </>
);
const shield = <path d="m12 3 8 3v6c0 4-4 7.2-8 9-4-1.8-8-5-8-9V6Z" />;
const question = <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4 M12 16v.1" />;
const archive = (
  <>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8" />
  </>
);
const layers = (
  <>
    <path d="m12 3 9 5-9 5-9-5Z M3 12l9 5 9-5 M3 16l9 5 9-5" />
  </>
);
const branch = (
  <>
    <circle cx="6.5" cy="5.5" r="2.5" />
    <circle cx="6.5" cy="18.5" r="2.5" />
    <circle cx="18" cy="9" r="2.5" />
    <path d="M6.5 8v8 M6.5 15.5C13 15.5 18 15 18 11.5" />
  </>
);
const slider = (
  <>
    <path d="M4 8h8 M18 8h2 M4 16h2 M12 16h8" />
    <circle cx="15" cy="8" r="3" />
    <circle cx="9" cy="16" r="3" />
  </>
);
const sun = (
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2 M12 19.5v2 M2.5 12h2 M19.5 12h2 M5.3 5.3l1.4 1.4 M17.3 17.3l1.4 1.4 M5.3 18.7l1.4-1.4 M17.3 6.7l1.4-1.4" />
  </>
);
const pin = <path d="M9 3.5h6 M10 3.5v6l-3 4v2h10v-2l-3-4v-6 M12 15.5v5" />;

export const Plus = icon("Plus", <path d="M12 4.5v15 M4.5 12h15" />);
export const Minus = icon("Minus", <path d="M5 12h14" />);
export const Mic = icon(
  "Mic",
  <>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0 M12 18v3" />
  </>,
);
export const X = icon("X", <path d="m6 6 12 12 M18 6 6 18" />);
export const Check = icon("Check", <path d="m5 12 4.5 4.5L19 7" />);
export const ChevronDown = icon("ChevronDown", <path d="m6 9 6 6 6-6" />);
export const ChevronRight = icon("ChevronRight", <path d="m9 6 6 6-6 6" />);
export const Hash = icon("Hash", <path d="m10 3-3 18m10-18-3 18M4 8h16M3 16h16" />);
export const Lock = icon(
  "Lock",
  <>
    <rect x="5" y="10.5" width="14" height="10.5" rx="3" />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
  </>,
);
export const ChevronLeft = icon("ChevronLeft", <path d="m15 6-6 6 6 6" />);
export const CornerUpLeft = icon("CornerUpLeft", <path d="m10 15-5-5 5-5 M5 10h9a5 5 0 0 1 5 5v4" />);
export const ChevronsUpDown = icon("ChevronsUpDown", <path d="m7 8 5-5 5 5 M7 16l5 5 5-5" />);
export const ArrowRight = icon("ArrowRight", <path d="M4 12h16m-6-6 6 6-6 6" />);
export const ArrowLeft = icon("ArrowLeft", <path d="M20 12H4m6-6-6 6 6 6" />);
export const ArrowUp = icon("ArrowUp", <path d="M12 20V4m-6 6 6-6 6 6" />);
/** The pile queued messages wait in: the front card, and two behind it. */
export const Queue = icon(
  "Queue",
  <>
    <rect x="4" y="11" width="16" height="9" rx="2.5" />
    <path d="M7 7.5h10 M10 4h4" />
  </>,
);
export const ArrowDown = icon("ArrowDown", <path d="M12 4v16m-6-6 6 6 6-6" />);
export const ArrowDownUp = icon("ArrowDownUp", <path d="M7 4v16M3.5 16.5 7 20l3.5-3.5M17 20V4m-3.5 3.5L17 4l3.5 3.5" />);
export const ArrowLeftRight = icon("ArrowLeftRight", <path d="M4 8h16m-4-4 4 4-4 4 M20 16H4m4-4-4 4 4 4" />);
export const ArrowUpRight = icon("ArrowUpRight", <path d="M6 18 18 6 M7 6h11v11" />);
export const ExternalLink = icon(
  "ExternalLink",
  <>
    <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6 M15 3h6v6 M11 13 21 3" />
  </>,
);
export const Search = icon("Search", lens);
export const ZoomIn = icon(
  "ZoomIn",
  <>
    {lens}
    <path d="M8 11h6 M11 8v6" />
  </>,
);
export const ZoomOut = icon(
  "ZoomOut",
  <>
    {lens}
    <path d="M8 11h6" />
  </>,
);
export const MoreHorizontal = icon(
  "MoreHorizontal",
  <>
    <circle cx="5" cy="12" r=".8" />
    <circle cx="12" cy="12" r=".8" />
    <circle cx="19" cy="12" r=".8" />
  </>,
);
export const MoreVertical = icon(
  "MoreVertical",
  <>
    <circle cx="12" cy="5" r=".8" />
    <circle cx="12" cy="12" r=".8" />
    <circle cx="12" cy="19" r=".8" />
  </>,
);
export const Play = icon("Play", <path d="M7 4.5 20 12 7 19.5Z" />);
export const Pause = icon("Pause", <path d="M8 5v14 M16 5v14" />);
export const Square = icon("Square", frame);
export const SquarePlus = icon(
  "SquarePlus",
  <>
    {frame}
    <path d="M12 8v8 M8 12h8" />
  </>,
);
export const SquareMinus = icon(
  "SquareMinus",
  <>
    {frame}
    <path d="M8 12h8" />
  </>,
);
export const SquareDot = icon(
  "SquareDot",
  <>
    {frame}
    <circle cx="12" cy="12" r="2" />
  </>,
);
export const SquareSlash = icon(
  "SquareSlash",
  <>
    {frame}
    <path d="m8 16 8-8" />
  </>,
);
export const Copy = icon(
  "Copy",
  <>
    <rect x="8.5" y="8.5" width="12" height="12" rx="3" />
    <path d="M5.5 15.5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" />
  </>,
);
export const Upload = icon("Upload", <path d="M4 15v4a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-4 M12 15V3.5m-5 5 5-5 5 5" />);
export const Download = icon("Download", <path d="M4 15v4a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-4 M12 3.5v12m-5-5 5 5 5-5" />);
export const Maximize2 = icon("Maximize2", <path d="M14 4h6v6 M20 4l-6 6 M10 20H4v-6 M4 20l6-6" />);
export const Minimize2 = icon("Minimize2", <path d="M4 14h6v6 M10 14l-6 6 M20 10h-6V4 M14 10l6-6" />);
/** Four corners opening outward: make a pane fill the window. */
export const Expand = icon("Expand", <path d="M4 9V6.5A2.5 2.5 0 0 1 6.5 4H9 M15 4h2.5A2.5 2.5 0 0 1 20 6.5V9 M20 15v2.5a2.5 2.5 0 0 1-2.5 2.5H15 M9 20H6.5A2.5 2.5 0 0 1 4 17.5V15" />);
/** Four corners turned inward: give the window back. */
export const Shrink = icon("Shrink", <path d="M9 4v2.5A2.5 2.5 0 0 1 6.5 9H4 M15 4v2.5A2.5 2.5 0 0 0 17.5 9H20 M20 15h-2.5a2.5 2.5 0 0 0-2.5 2.5V20 M4 15h2.5A2.5 2.5 0 0 1 9 17.5V20" />);
export const Send = icon("Send", <path d="m3 4 18 8-18 8 3-8Z M6 12h15" />);
export const Trash2 = icon(
  "Trash2",
  <>
    <path d="M4 6.5h16 M9.5 6.5v-2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2 M6 6.5l.8 11.6a2 2 0 0 0 2 1.9h6.4a2 2 0 0 0 2-1.9L18 6.5" />
  </>,
);
export const Pencil = icon("Pencil", <path d="M16.2 4.6a2.26 2.26 0 0 1 3.2 3.2L8.5 18.7 4 20l1.3-4.5Z" />);
/** Compose: a sheet with its corner left open for the pen. */
export const PenSquare = icon("PenSquare", <path d="M12 4H7.5A3.5 3.5 0 0 0 4 7.5v9A3.5 3.5 0 0 0 7.5 20h9a3.5 3.5 0 0 0 3.5-3.5V12 M17.9 3.6a1.77 1.77 0 0 1 2.5 2.5L12.5 14 9 15l1-3.5Z" />);
export const Home = icon("Home", <path d="m3.5 10.5 8.5-7 8.5 7 M5.5 9v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V9" />);
export const Orclings = icon("Orclings", <path d="M12 3.5c7 0 8.5 1.5 8.5 8.5s-1.5 8.5-8.5 8.5-8.5-1.5-8.5-8.5S5 3.5 12 3.5Z M9 10v4 M15 10v4" />);
export const FolderGit2 = icon("FolderGit2", folder);
export const Folder = icon("Folder", folder);
export const FolderPlus = icon(
  "FolderPlus",
  <>
    {folder}
    <path d="M12 11v5.5 M9.25 13.75h5.5" />
  </>,
);
export const Zap = icon("Zap", <path d="m14 2-11 12h8l-1 8 11-12h-8Z" />);
export const FolderOpen = icon("FolderOpen", <path d="M3 18V5.5a2 2 0 0 1 2-2h4l3.5 3.5H18a2 2 0 0 1 2 2v1 M3 19l3-8h15l-3 9H5a2 2 0 0 1-2-1Z" />);
export const MessageSquare = icon("MessageSquare", <path d="M5.5 4h13A2.5 2.5 0 0 1 21 6.5v10a2.5 2.5 0 0 1-2.5 2.5H9l-6 3V6.5A2.5 2.5 0 0 1 5.5 4Z" />);
export const MailOpen = icon("MailOpen", <path d="m3 10 9-6.5 9 6.5v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z M3.5 10.5 12 16l8.5-5.5" />);
export const Brain = icon("Brain", layers);
/** Projects: a folder with another behind it. */
export const Folders = icon(
  "Folders",
  <path d="M2.5 11v-1a2 2 0 0 1 2-2h3l2.5 2.5h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4.5a2 2 0 0 1-2-2Z M7 5.5a2 2 0 0 1 2-2h3L14.5 6h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2" />,
);
/** An Orcling: the mascot's soft body and two upright eyes. */
export const Orcling = icon("Orcling", <path d="M12 4.5c5.6 0 7.5 1.9 7.5 7.5s-1.9 7.5-7.5 7.5-7.5-1.9-7.5-7.5 1.9-7.5 7.5-7.5Z M9.75 10.25v2.5 M14.25 10.25v2.5" />);
export const Workflow = icon(
  "Workflow",
  <>
    <circle cx="12" cy="5.5" r="3" />
    <circle cx="4.5" cy="18" r="3" />
    <circle cx="19.5" cy="18" r="3" />
    <path d="M8.5 7.5a9 9 0 0 0-4 7 M15.5 7.5a9 9 0 0 1 4 7 M8 19.5h8" />
  </>,
);
export const GitBranch = icon("GitBranch", branch);
export const GitFork = icon(
  "GitFork",
  <>
    <circle cx="5.5" cy="5.5" r="2.5" />
    <circle cx="18.5" cy="5.5" r="2.5" />
    <circle cx="12" cy="19" r="2.5" />
    <path d="M5.5 8v1c0 4 6.5 2 6.5 6v1.5 M18.5 8v1c0 4-6.5 2-6.5 6" />
  </>,
);
export const GitPullRequest = icon(
  "GitPullRequest",
  <>
    <circle cx="6" cy="6" r="2.75" />
    <circle cx="6" cy="18" r="2.75" />
    <circle cx="18" cy="18" r="2.75" />
    <path d="M6 8.75v6.5 M18 15.25V10a4 4 0 0 0-4-4h-1.5 M15 3.5 12.5 6 15 8.5" />
  </>,
);
export const GitMerge = icon(
  "GitMerge",
  <>
    <circle cx="6" cy="6" r="2.75" />
    <circle cx="6" cy="18" r="2.75" />
    <circle cx="18" cy="12" r="2.75" />
    <path d="M6 8.75v6.5 M6 8.75c0 2 2 3.25 4.5 3.25h4.75" />
  </>,
);
export const GitPullRequestClosed = icon(
  "GitPullRequestClosed",
  <>
    <circle cx="6" cy="6" r="2.75" />
    <circle cx="6" cy="18" r="2.75" />
    <circle cx="18" cy="18" r="2.75" />
    <path d="M6 8.75v6.5 M18 15.25V12 M15.5 3.5l5 5 M20.5 3.5l-5 5" />
  </>,
);
export const GitCommitHorizontal = icon(
  "GitCommitHorizontal",
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M3 12h5 M16 12h5" />
  </>,
);
export const LayoutGrid = icon(
  "LayoutGrid",
  <>
    <rect x="3.5" y="3.5" width="6" height="6" rx="1.5" />
    <rect x="14.5" y="3.5" width="6" height="6" rx="1.5" />
    <rect x="3.5" y="14.5" width="6" height="6" rx="1.5" />
    <rect x="14.5" y="14.5" width="6" height="6" rx="1.5" />
  </>,
);
/** A pane with a short bar on the side its column opens: the sidebar's toggle, and the panel's. */
export const PanelLeft = icon(
  "PanelLeft",
  <>
    {pane}
    <path d="M8 9v6" />
  </>,
);
export const PanelRight = icon(
  "PanelRight",
  <>
    {pane}
    <path d="M16 9v6" />
  </>,
);
/** The panel toggle's mark, drawn on the side the panel docks. */
export function PanelIcon({ side, ...props }: IconProps & { side: "left" | "right" }) {
  return side === "left" ? <PanelLeft {...props} /> : <PanelRight {...props} />;
}
export const PanelRightClose = icon(
  "PanelRightClose",
  <>
    {pane}
    <path d="M15.5 4.5v15 M8 9.5l2.5 2.5L8 14.5" />
  </>,
);
export const Columns2 = icon(
  "Columns2",
  <>
    {pane}
    <path d="M12 4.5v15" />
  </>,
);
export const AppWindow = icon("AppWindow", windowFrame);
export const Monitor = icon(
  "Monitor",
  <>
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <path d="M12 17v4 M8 21h8" />
  </>,
);
export const Laptop = icon("Laptop", <path d="M5 16V5.5A1.5 1.5 0 0 1 6.5 4h11A1.5 1.5 0 0 1 19 5.5V16 M5 16h14l3 4H2Z" />);
export const Cloud = icon("Cloud", <path d="M7.5 19h10a4.5 4.5 0 0 0 .5-8.97A6.5 6.5 0 0 0 5.6 11.3 4 4 0 0 0 7.5 19Z" />);
export const Smartphone = icon(
  "Smartphone",
  <>
    <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </>,
);
export const Tablet = icon(
  "Tablet",
  <>
    <rect x="4" y="3" width="16" height="18" rx="2.5" />
    <path d="M11 18h2" />
  </>,
);
export const Power = icon("Power", <path d="M12 3v8 M7.4 6.2a7.5 7.5 0 1 0 9.2 0" />);
export const People = icon(
  "People",
  <>
    <circle cx="9" cy="8.5" r="3.25" />
    <path d="M3.5 19c.6-3 2.8-4.75 5.5-4.75s4.9 1.75 5.5 4.75" />
    <path d="M15.25 5.6a3.25 3.25 0 0 1 0 5.8" />
    <path d="M17 14.6c1.9.6 3.15 2.1 3.5 4.4" />
  </>,
);
export const PersonPlus = icon(
  "PersonPlus",
  <>
    <circle cx="8.5" cy="8" r="3.25" />
    <path d="M3 19c.6-3.25 2.8-5 5.5-5s4.9 1.75 5.5 5 M18.5 7v6 M15.5 10h6" />
  </>,
);
export const SmilePlus = icon(
  "SmilePlus",
  <>
    <path d="M20.5 12A8.5 8.5 0 1 1 12 3.5" />
    <path d="M8.75 14.25c.85 1.1 1.95 1.75 3.25 1.75s2.4-.65 3.25-1.75" />
    <path d="M9.25 10h.01 M14.75 10h.01" />
    <path d="M19 2.75v5 M16.5 5.25h5" />
  </>,
);
export const Clock = icon(
  "Clock",
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>,
);
export const AlarmClock = icon(
  "AlarmClock",
  <>
    {clockFace}
    <path d="m3.5 5.5 3-2.5 M17.5 3l3 2.5" />
  </>,
);
export const CalendarClock = icon(
  "CalendarClock",
  <>
    <rect x="3.5" y="4.5" width="17" height="16" rx="3.5" />
    <path d="M3.5 10h17 M8 2.5v4 M16 2.5v4" />
  </>,
);
export const History = icon("History", <path d="M3 10a9 9 0 1 1 1 7 M3 4v6h6 M12 7v5l4 2" />);
export const RotateCcw = icon("RotateCcw", <path d="M3 10a9 9 0 1 1 1 7 M3 4v6h6" />);
export const RefreshCw = icon("RefreshCw", <path d="M3.5 10A8.5 8.5 0 0 1 18 6l2.5 3 M20.5 3v6h-6 M20.5 14A8.5 8.5 0 0 1 6 18l-2.5-3 M3.5 21v-6h6" />);
export const Loader2 = icon("Loader2", <path d="M12 3.5A8.5 8.5 0 1 1 3.5 12" />);
export const LoaderCircle = icon("LoaderCircle", <path d="M12 3.5A8.5 8.5 0 1 1 3.5 12" />);
export const CircleDashed = icon("CircleDashed", <circle cx="12" cy="12" r="8.5" strokeDasharray="3.3 3.38" />);
export const CircleReview = icon(
  "CircleReview",
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.5 10h7 M8.5 14h5" />
  </>,
);
export const CircleCheck = icon(
  "CircleCheck",
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12.25 2.5 2.5 4.75-5" />
  </>,
);
export const AlertCircle = icon(
  "AlertCircle",
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5v5 M12 16v.1" />
  </>,
);
export const CircleHelp = icon(
  "CircleHelp",
  <>
    <circle cx="12" cy="12" r="8.5" />
    {question}
  </>,
);
export const ShieldCheck = icon(
  "ShieldCheck",
  <>
    {shield}
    <path d="m8 12 2.5 2.5 5.5-5.5" />
  </>,
);
export const ShieldQuestion = icon(
  "ShieldQuestion",
  <>
    {shield}
    {question}
  </>,
);
export const ShieldOff = icon(
  "ShieldOff",
  <>
    {shield}
    <path d="M5 20 19 4" />
  </>,
);
export const Eye = icon(
  "Eye",
  <>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);
export const Archive = icon(
  "Archive",
  <>
    {archive}
    <path d="M10 12h4" />
  </>,
);
export const ArchiveRestore = icon(
  "ArchiveRestore",
  <>
    {archive}
    <path d="M12 18v-7m-3 3 3-3 3 3" />
  </>,
);
export const Pin = icon("Pin", pin);
export const Star = icon("Star", <path d="M12 4l2.35 4.76 5.25.77-3.8 3.7.9 5.23L12 15.99l-4.7 2.47.9-5.23-3.8-3.7 5.25-.77z" />);
export const PinOff = icon(
  "PinOff",
  <>
    <path d="M10 3.5h5 M14 3.5v5 M8.5 10l-1.5 3.5v2h7 M12 15.5v5 M3 3l18 18" />
  </>,
);
export const ThumbsUp = icon(
  "ThumbsUp",
  <>
    <rect x="3" y="10" width="4" height="10" rx="1" />
    <path d="M7 11l5-8h2v7h5a2 2 0 0 1 2 2.5l-1.5 6a2 2 0 0 1-2 1.5H7" />
  </>,
);
export const SignalLow = icon("SignalLow", <path d="M5 20v-3" />);
export const SignalMedium = icon("SignalMedium", <path d="M5 20v-3 M10 20v-7" />);
export const SignalHigh = icon("SignalHigh", <path d="M5 20v-3 M10 20v-7 M15 20V9" />);
export const CircleUser = icon(
  "CircleUser",
  <>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="10" r="3" />
    <path d="M6.6 18.4a6.5 6.5 0 0 1 10.8 0" />
  </>,
);
export const Signal = icon("Signal", <path d="M5 20v-3 M10 20v-7 M15 20V9 M20 20V5" />);
export const List = icon("List", <path d="M4 6h1 M9 6h11 M4 12h1 M9 12h11 M4 18h1 M9 18h11" />);
export const ListChecks = icon("ListChecks", <path d="m3 6 1.5 1.5L7 5 M11 6h9 M3 12l1.5 1.5L7 11 M11 12h9 M3 18l1.5 1.5L7 17 M11 18h9" />);
export const ListTodo = icon(
  "ListTodo",
  <>
    {frame}
    <path d="m8 12.25 2.75 2.75L16 9.5" />
  </>,
);
export const Funnel = icon("Funnel", <path d="M4 5h16l-6 7.5V18l-4 2v-7.5Z" />);
export const ListFilter = icon("ListFilter", <path d="M3.5 6h17 M7 12h10 M10 18h4" />);
export const FilePlain = icon("FilePlain", paper);
export const FileText = icon(
  "FileText",
  <>
    {paper}
    <path d="M8 13h8 M8 17h6" />
  </>,
);
/** Changes: what was added over what was taken away, with no page drawn around them. */
export const FileDiff = icon("FileDiff", <path d="M12 2.5v11.5 M6.25 8.25h11.5 M6.25 20h11.5" />);
export const FileCode2 = icon(
  "FileCode2",
  <>
    {paper}
    <path d="m9 12-3 3 3 3 M15 12l3 3-3 3" />
  </>,
);
export const BookText = icon(
  "BookText",
  <>
    <path d="M5 18.5A2.5 2.5 0 0 1 7.5 16H19V3H7.5A2.5 2.5 0 0 0 5 5.5Z M5 18.5A2.5 2.5 0 0 0 7.5 21H19" />
  </>,
);
export const Bold = icon("Bold", <path strokeWidth="2.25" d="M6 4h7a4 4 0 0 1 0 8H6V4Z M6 12h8a4 4 0 0 1 0 8H6Z" />);
export const Heading2 = icon("Heading2", <path d="M4 5v14 M13 5v14 M4 12h9 M17 15a2 2 0 0 1 4 0c0 2-4 2.5-4 5h4" />);
export const Italic = icon("Italic", <path d="M10 4h9 M5 20h9 M15 4 9 20" />);
export const Strikethrough = icon("Strikethrough", <path d="M18 6c-1-2-3-3-6-3-4 0-6 2-6 4 0 3 4 4 6 5 M6 18c1 2 3 3 6 3 4 0 6-2 6-4 0-2-2-3-4-4 M3 12h18" />);
export const Plug = icon("Plug", <path d="M9 3v4.5 M15 3v4.5 M6.5 7.5h11v3.5a5.5 5.5 0 0 1-11 0z M12 16.5V21" />);
export const Link2 = icon("Link2", <path d="m9 15 6-6 M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0 M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(2 0) scale(.84 1)" />);
export const Text = icon("Text", <path d="M4 5h16 M12 5v15 M8 20h8 M4 5v3 M20 5v3" />);
export const Quote = icon("Quote", <path d="M4 7h6v7H5c0 3 1 4 3 5 M14 7h6v7h-5c0 3 1 4 3 5" />);
export const ListOrdered = icon("ListOrdered", <path d="M10 6h10 M10 12h10 M10 18h10 M3 4h1v4 M3 8h2 M3 11c2-1 3 1 1 2l-1 1h2 M3 17h2l-1 1 1 1-2 1" />);
export const Code2 = icon("Code2", <path d="m7 7-5 5 5 5 M17 7l5 5-5 5 M14 4l-4 16" />);
export const Terminal = icon(
  "Terminal",
  <>
    {pane}
    <path d="m7.5 9.5 3 2.5-3 2.5 M13 14.5h3.5" />
  </>,
);
export const Slash = icon("Slash", <path d="M16 3 8 21" />);
export const AtSign = icon(
  "AtSign",
  <>
    <circle cx="11.5" cy="11.5" r="3.5" />
    <path d="M15 8v6c0 3 6 3 6-3a9 9 0 1 0-4 8.5" />
  </>,
);
export const Image = icon(
  "Image",
  <>
    {frame}
    <circle cx="8.75" cy="8.75" r="1.75" />
    <path d="m4 17 5-5 4 4 2.5-2.5 4.5 4.5" />
  </>,
);
export const Globe = icon(
  "Globe",
  <>
    <circle cx="12" cy="12" r="9" />
    <ellipse cx="12" cy="12" rx="4" ry="9" />
    <path d="M3 12h18" />
  </>,
);
export const Lightbulb = icon("Lightbulb", <path d="M9 17c0-3-3.5-3.5-3.5-7.5a6.5 6.5 0 0 1 13 0c0 4-3.5 4.5-3.5 7.5Z M9.5 20.5h5" />);
export const Hammer = icon("Hammer", <path d="m3 19 9-9 3 3-9 9Z M9 6l4-4 8 8-4 4-3-3 1-1-3-3-1 1Z" />);
export const Wand = icon("Wand", <path d="M4 20 14 10 M17.5 3.5v6 M14.5 6.5h6" />);
/** A cog of eight shallow teeth, its outline drawn from arcs so it stays round at any size. */
export const Settings = icon(
  "Settings",
  <>
    <path d="M10.11 4.95 L10.60 2.60 A9.5 9.5 0 0 1 13.40 2.60 L13.89 4.95 A7.3 7.3 0 0 1 15.65 5.68 L17.65 4.36 A9.5 9.5 0 0 1 19.64 6.35 L18.32 8.35 A7.3 7.3 0 0 1 19.05 10.11 L21.40 10.60 A9.5 9.5 0 0 1 21.40 13.40 L19.05 13.89 A7.3 7.3 0 0 1 18.32 15.65 L19.64 17.65 A9.5 9.5 0 0 1 17.65 19.64 L15.65 18.32 A7.3 7.3 0 0 1 13.89 19.05 L13.40 21.40 A9.5 9.5 0 0 1 10.60 21.40 L10.11 19.05 A7.3 7.3 0 0 1 8.35 18.32 L6.35 19.64 A9.5 9.5 0 0 1 4.36 17.65 L5.68 15.65 A7.3 7.3 0 0 1 4.95 13.89 L2.60 13.40 A9.5 9.5 0 0 1 2.60 10.60 L4.95 10.11 A7.3 7.3 0 0 1 5.68 8.35 L4.36 6.35 A9.5 9.5 0 0 1 6.35 4.36 L8.35 5.68 A7.3 7.3 0 0 1 10.11 4.95Z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);
export const Settings2 = icon("Settings2", slider);
export const SlidersHorizontal = icon("SlidersHorizontal", slider);
export const Sun = icon("Sun", sun);
export const Moon = icon("Moon", <path d="M20.5 14A9 9 0 0 1 10 3.5 9 9 0 1 0 20.5 14Z" />);
export const SunMoon = icon(
  "SunMoon",
  <>
    <path d="M12 3a9 9 0 1 0 9 9 7.5 7.5 0 0 1-9-9Z M19 2v4 M17 4h4" />
  </>,
);
export const Bell = icon("Bell", <path d="M18 15.5V10a6 6 0 0 0-12 0v5.5L4.5 18h15L18 15.5Z M10 21h4" />);

/** Quiet transcript glyphs: matched optical size, open silhouettes, no window chrome. */
export const WorkRead = icon("WorkRead", <path d="M12 6.5C9.4 4.7 6.7 4 3.5 4.5v14c3.2-.5 5.9.2 8.5 2 2.6-1.8 5.3-2.5 8.5-2v-14c-3.2-.5-5.9.2-8.5 2Zm0 0v14" />);
export const WorkEdit = icon("WorkEdit", <path d="m14.7 4.8 1.5-1.5a2.1 2.1 0 0 1 3 0l1.5 1.5a2.1 2.1 0 0 1 0 3L9.2 19.3 3.5 21l1.7-5.7L14.7 4.8Zm0 0 4.5 4.5" />);
export const WorkCommand = icon(
  "WorkCommand",
  <>
    <rect x="3" y="4.5" width="18" height="15" rx="3" />
    <path d="m7 9 3 3-3 3m6 0h4" />
  </>,
);
export const WorkSearch = icon(
  "WorkSearch",
  <>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.3 15.3 5 5" />
  </>,
);
export const WorkMessage = icon("WorkMessage", <path d="M20.5 11.5a8.5 8.5 0 0 1-12.4 7.6L3 20.5l1.4-5.1a8.5 8.5 0 1 1 16.1-3.9Z" />);
/** Solid collaboration marks, approved separately from the routine outline glyphs. */
export const WorkDelegate = icon(
  "WorkDelegate",
  <g fill="currentColor" stroke="none">
    <path d="M5 2h9a3 3 0 0 1 3 3v.5H9A3.5 3.5 0 0 0 5.5 9v8H5a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3Z" />
    <path fillRule="evenodd" d="M10 7.5h9a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3Zm2 3v2h3.1L11 16.6l1.4 1.4 4.1-4.1V17h2v-6.5Z" />
  </g>,
);
const workAgentFlower =
  "M12 5C11 1 4 1 3 6c-.6 2.8 1 4.8 3 6-4 1.3-4.6 6-1.4 8.5C7.5 22.8 11 21 12 19c1 3 6 4 8.5.5 2.1-2.7.5-6-2.5-7.5 3.8-1.3 4.7-5.2 2.1-8.1C17.7 1.3 13.2 2 12 5Zm-4.5 7.3 1.5-1.5 2.1 2.1 4.5-4.5 1.5 1.5-6 6Z";
export const WorkAgent = icon(
  "WorkAgent",
  <g fill="currentColor" stroke="none" fillRule="evenodd">
    <path d={workAgentFlower} />
    <path d={workAgentFlower} fill="var(--accent-ink)" style={{ clipPath: "inset(0 0 50% 0)" }} />
  </g>,
);
export const WorkLive = icon("WorkLive", <path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5M12 20.5A8.5 8.5 0 0 1 3.5 12" />);
