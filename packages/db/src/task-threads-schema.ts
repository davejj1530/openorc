/**
 * Threads linked to a task: its working threads, current and earlier, with no label, and the threads its buttons
 * started, by the button's label. One thread can be listed under several tasks.
 */
export const taskThreadsMigration = `
CREATE TABLE task_threads (
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
 label TEXT, created_at INTEGER NOT NULL,
 PRIMARY KEY (task_id, thread_id)
);
CREATE INDEX task_threads_task ON task_threads(task_id, created_at);
CREATE INDEX task_threads_thread ON task_threads(thread_id);
`;
