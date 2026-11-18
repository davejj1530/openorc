import "react";

/** Elements Chromium has that React's types do not declare yet. */
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      /** A customizable select's copy of its chosen option. */
      selectedcontent: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}
