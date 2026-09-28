import { forwardRef, type ReactNode, type SVGProps } from "react";

/** Codex-generated Precision Outline family. Geometry is original, on a 24px grid. */
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
        strokeWidth={1.75}
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

const frame = <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />;
const windowFrame = (
  <>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M3 9h18" />
  </>
);
const paper = <path d="M14 3.5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9Z M14 3.5v6h6" />;
const folder = <path d="M3 8V5.5a2 2 0 0 1 2-2h4.5L13 7h6a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8h7l2-2" />;
const clockFace = (
  <>
    <circle cx="12" cy="13" r="7.5" />
    <path d="M12 9v4l3 2" />
  </>
);
const lens = (
  <>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m15.3 15.3 5.2 5.2" />
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
    <path d="M4 6h3m4 0h9 M4 12h9m4 0h3 M4 18h3m4 0h9" />
    <circle cx="9" cy="6" r="2" />
    <circle cx="15" cy="12" r="2" />
    <circle cx="9" cy="18" r="2" />
  </>
);
const sun = (
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2 M12 19.5v2 M2.5 12h2 M19.5 12h2 M5.3 5.3l1.4 1.4 M17.3 17.3l1.4 1.4 M5.3 18.7l1.4-1.4 M17.3 6.7l1.4-1.4" />
  </>
);
const pin = <path d="M9 3.5h6 M10 3.5v6l-3 4v2h10v-2l-3-4v-6 M12 15.5v5" />;

export const Plus = icon("Plus", <path d="M12 5v14 M5 12h14" />);
export const Minus = icon("Minus", <path d="M5 12h14" />);
export const X = icon("X", <path d="m6 6 12 12 M18 6 6 18" />);
export const Check = icon("Check", <path d="m5 12 4.5 4.5L19 7" />);
export const ChevronDown = icon("ChevronDown", <path d="m6 9 6 6 6-6" />);
export const ChevronRight = icon("ChevronRight", <path d="m9 6 6 6-6 6" />);
export const ChevronsUpDown = icon("ChevronsUpDown", <path d="m7 8 5-5 5 5 M7 16l5 5 5-5" />);
export const ArrowRight = icon("ArrowRight", <path d="M4 12h16m-6-6 6 6-6 6" />);
export const ArrowLeft = icon("ArrowLeft", <path d="M20 12H4m6-6-6 6 6 6" />);
export const ArrowUp = icon("ArrowUp", <path d="M12 20V4m-6 6 6-6 6 6" />);
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
    <path d="M7.5 10.5h6 M10.5 7.5v6" />
  </>,
);
export const ZoomOut = icon(
  "ZoomOut",
  <>
    {lens}
    <path d="M7.5 10.5h6" />
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
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M15 4H6a2 2 0 0 0-2 2v9" />
  </>,
);
export const Upload = icon("Upload", <path d="M4 15v4a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-4 M12 15V3.5m-5 5 5-5 5 5" />);
export const Download = icon("Download", <path d="M4 15v4a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-4 M12 3.5v12m-5-5 5 5 5-5" />);
export const Maximize2 = icon("Maximize2", <path d="M14 4h6v6 M20 4l-6 6 M10 20H4v-6 M4 20l6-6" />);
export const Minimize2 = icon("Minimize2", <path d="M4 14h6v6 M10 14l-6 6 M20 10h-6V4 M14 10l6-6" />);
export const Send = icon("Send", <path d="m3 4 18 8-18 8 3-8Z M6 12h15" />);
export const Trash2 = icon(
  "Trash2",
  <>
    <path d="M3.5 6.5h17 M9 6.5v-3h6v3 M5.5 6.5l1 13a1.5 1.5 0 0 0 1.5 1h8a1.5 1.5 0 0 0 1.5-1l1-13 M10 10v7 M14 10v7" />
  </>,
);
export const Pencil = icon("Pencil", <path d="m5 15 11-11a1.4 1.4 0 0 1 2 0l2 2a1.4 1.4 0 0 1 0 2L9 19l-5 1Z M14 6l4 4" />);
export const PenSquare = icon("PenSquare", <path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5 M10 11l8-8 3 3-8 8-4 1Z M16 5l3 3" />);
export const Home = icon("Home", <path d="m3 10 9-7 9 7 M5 8.5v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-10 M9.5 20.5v-7h5v7" />);
export const FolderGit2 = icon("FolderGit2", folder);
export const Folder = icon("Folder", folder);
export const Zap = icon("Zap", <path d="m14 2-11 12h8l-1 8 11-12h-8Z" />);
export const FolderOpen = icon("FolderOpen", <path d="M3 18V5.5a2 2 0 0 1 2-2h4l3.5 3.5H18a2 2 0 0 1 2 2v1 M3 19l3-8h15l-3 9H5a2 2 0 0 1-2-1Z" />);
export const Inbox = icon("Inbox", <path d="m3 12 4-8h10l4 8v7a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19Z M3 12h5l2 3h4l2-3h5" />);
export const MessageSquare = icon("MessageSquare", <path d="M5.5 4h13A2.5 2.5 0 0 1 21 6.5v10a2.5 2.5 0 0 1-2.5 2.5H9l-6 3V6.5A2.5 2.5 0 0 1 5.5 4Z" />);
export const MailOpen = icon("MailOpen", <path d="m3 10 9-7 9 7v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19Z M3 10l9 6 9-6 M3.5 20l5.5-6 M20.5 20 15 14" />);
export const Brain = icon("Brain", layers);
export const SquareStack = icon("SquareStack", layers);
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
    <circle cx="6" cy="5.5" r="2.5" />
    <circle cx="6" cy="18.5" r="2.5" />
    <circle cx="18" cy="18.5" r="2.5" />
    <path d="M6 8v8 M18 16V9a3 3 0 0 0-3-3h-2 M16 3l-3 3 3 3" />
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
export const PanelLeft = icon(
  "PanelLeft",
  <>
    {frame}
    <path d="M9 3.5v17" />
  </>,
);
export const PanelRight = icon(
  "PanelRight",
  <>
    {frame}
    <path d="M15 3.5v17" />
  </>,
);
export const PanelRightClose = icon(
  "PanelRightClose",
  <>
    {frame}
    <path d="M15 3.5v17 M7 9l3 3-3 3" />
  </>,
);
export const Columns2 = icon(
  "Columns2",
  <>
    {frame}
    <path d="M12 3.5v17" />
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
export const Clock = icon(
  "Clock",
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7v5l3.5 2.5" />
  </>,
);
export const AlarmClock = icon(
  "AlarmClock",
  <>
    {clockFace}
    <path d="m3 5 3-2 M18 3l3 2 M7 19l-2 2 M17 19l2 2" />
  </>,
);
export const CalendarClock = icon(
  "CalendarClock",
  <>
    <path d="M9 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v3 M7 2v4 M16 2v4 M3 9h17" />
    <circle cx="16" cy="16" r="5.5" />
    <path d="M16 13v3h2.5" />
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
export const Signal = icon("Signal", <path d="M5 20v-3 M10 20v-7 M15 20V9 M20 20V5" />);
export const List = icon("List", <path d="M4 6h1 M9 6h11 M4 12h1 M9 12h11 M4 18h1 M9 18h11" />);
export const ListChecks = icon("ListChecks", <path d="m3 6 1.5 1.5L7 5 M11 6h9 M3 12l1.5 1.5L7 11 M11 12h9 M3 18l1.5 1.5L7 17 M11 18h9" />);
export const ListTodo = icon(
  "ListTodo",
  <>
    <path d="M14 3.5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9Z M7 9l1 1 2-2 M13 9h3 M7 14h2 M13 14h3 M7 17h2 M13 17h3" />
  </>,
);
export const ListFilter = icon("ListFilter", <path d="M3.5 6h17 M7 12h10 M10 18h4" />);
export const FileText = icon(
  "FileText",
  <>
    {paper}
    <path d="M8 13h8 M8 17h6" />
  </>,
);
export const FileDiff = icon(
  "FileDiff",
  <>
    {paper}
    <path d="M7 13h5 M9.5 10.5v5 M13 17h4" />
  </>,
);
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
    <path d="M6 20.5h14V3.5H6a2.5 2.5 0 0 0-2.5 2.5v12A2.5 2.5 0 0 1 6 15.5h14 M3.5 18a2.5 2.5 0 0 0 2.5 2.5 M8 7.5h8 M8 11h6" />
  </>,
);
export const Bold = icon("Bold", <path strokeWidth="2.25" d="M6 4h7a4 4 0 0 1 0 8H6V4Z M6 12h8a4 4 0 0 1 0 8H6Z" />);
export const Heading2 = icon("Heading2", <path d="M4 5v14 M13 5v14 M4 12h9 M17 15a2 2 0 0 1 4 0c0 2-4 2.5-4 5h4" />);
export const Italic = icon("Italic", <path d="M10 4h9 M5 20h9 M15 4 9 20" />);
export const Strikethrough = icon("Strikethrough", <path d="M18 6c-1-2-3-3-6-3-4 0-6 2-6 4 0 3 4 4 6 5 M6 18c1 2 3 3 6 3 4 0 6-2 6-4 0-2-2-3-4-4 M3 12h18" />);
export const Link2 = icon("Link2", <path d="m9 15 6-6 M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0 M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(2 0) scale(.84 1)" />);
export const Text = icon("Text", <path d="M4 5h16 M12 5v15 M8 20h8 M4 5v3 M20 5v3" />);
export const Quote = icon("Quote", <path d="M4 7h6v7H5c0 3 1 4 3 5 M14 7h6v7h-5c0 3 1 4 3 5" />);
export const ListOrdered = icon("ListOrdered", <path d="M10 6h10 M10 12h10 M10 18h10 M3 4h1v4 M3 8h2 M3 11c2-1 3 1 1 2l-1 1h2 M3 17h2l-1 1 1 1-2 1" />);
export const Code2 = icon("Code2", <path d="m7 7-5 5 5 5 M17 7l5 5-5 5 M14 4l-4 16" />);
export const Terminal = icon(
  "Terminal",
  <>
    {windowFrame}
    <path d="m7 12 3 2.5L7 17 M13 17h4" />
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
    <circle cx="8" cy="8" r="1.5" />
    <path d="m3.5 17 5-5 4 4 3-3 5 5" />
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
export const Lightbulb = icon("Lightbulb", <path d="M9 17c0-3-3.5-3.5-3.5-7.5a6.5 6.5 0 0 1 13 0c0 4-3.5 4.5-3.5 7.5Z M9 20.5h6 M12 17v-6m-2-1 2 1 2-1" />);
export const Hammer = icon("Hammer", <path d="m3 19 9-9 3 3-9 9Z M9 6l4-4 8 8-4 4-3-3 1-1-3-3-1 1Z" />);
export const Sparkles = icon("Sparkles", <path d="m10 3 2.5 6.5L19 12l-6.5 2.5L10 21l-2.5-6.5L1 12l6.5-2.5Z M19 2v4 M17 4h4 M21 17v4 M19 19h4" />);
export const Settings = icon(
  "Settings",
  <>
    <path d="m9 3-.5 3-2 1-3-.5-1.5 3 2.5 2v2L2 15l1.5 3 3-.5 2 1 .5 3h6l.5-3 2-1 3 .5 1.5-3-2.5-2.5v-2l2.5-2-1.5-3-3 .5-2-1L15 3Z" />
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
