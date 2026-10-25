/** Where a notice leads: its thread, its task, or neither. */
export interface NoticeTarget {
  threadId: string | null;
  taskId: string | null;
}

/** What a window or a phone has on screen right now, and whether that screen has the person's attention. */
export interface NoticePresence {
  focused: boolean;
  threadIds: readonly string[];
  taskId: string | null;
}

/** A notice the person is already looking at needs no alert. */
export function noticeVisible(target: NoticeTarget, presence: NoticePresence): boolean {
  return presence.focused && Boolean((target.threadId && presence.threadIds.includes(target.threadId)) || (target.taskId && target.taskId === presence.taskId));
}
