import { AccountUsage } from "./AccountUsage";

/** The thread list's foot: the open thread's weekly usage, in the fullest look that fits the list's width. */
export function SidebarFooter() {
  return (
    <footer className="sidebar-footer">
      <div className="sidebar-usage">
        <AccountUsage />
      </div>
    </footer>
  );
}
