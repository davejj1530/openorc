"""Read-only team timing report. Usage: python3 scripts/team-timeline.py DB EXECUTION_ID [...].
No prompts, tool arguments, outputs, or credentials are printed.
"""
import json, pathlib, re, sqlite3, statistics, sys

def journal(db, execution_id):
    columns = {row[1] for row in db.execute('PRAGMA table_info(team_executions)')}
    if 'payload' in columns:  # Ledgers before version 40 kept each journal as one JSON document.
        row = db.execute('SELECT payload FROM team_executions WHERE id=?', (execution_id,)).fetchone()
        return json.loads(row[0]) if row else None
    row = db.execute('SELECT state, created_at, updated_at FROM team_executions WHERE id=?', (execution_id,)).fetchone()
    if not row: return None
    def rows(sql, decode): return [decode(r) for r in db.execute(sql, (execution_id,))]
    return {
        'state': row[0], 'createdAt': row[1], 'updatedAt': row[2],
        'actors': rows('SELECT id, state, details FROM team_actors WHERE execution_id=? ORDER BY position', lambda r: {'id': r[0], 'state': r[1], **json.loads(r[2])}),
        'attempts': rows('SELECT id, actor_id, run_id, state, created_at, ended_at, details FROM team_attempts WHERE execution_id=? ORDER BY position',
                         lambda r: {'id': r[0], 'actorId': r[1], 'runId': r[2], 'state': r[3], 'createdAt': r[4], 'endedAt': r[5], **json.loads(r[6])}),
        'messages': rows('SELECT id, attempt_id, created_at, details FROM team_messages WHERE execution_id=? ORDER BY sequence', lambda r: {'id': r[0], 'attemptId': r[1], 'createdAt': r[2], **json.loads(r[3])}),
    }

def attempt_tool_activity(db, attempt, end):
    window = (attempt['runId'], attempt['createdAt'], attempt.get('endedAt') or end)
    started = db.execute("SELECT ts,payload FROM events WHERE run_id=? AND kind='tool.started' AND ts>=? AND ts<? ORDER BY ts", window).fetchall()
    starts = {json.loads(payload).get('toolCallId'): ts for ts, payload in started}
    intervals = []
    for ts, payload in db.execute("SELECT ts,payload FROM events WHERE run_id=? AND kind='tool.completed' AND ts>=? AND ts<?", window):
        event = json.loads(payload)
        begun = starts.get(event.get('toolCallId'))
        if begun is not None: intervals.append((begun, ts))
    tool_ms = 0
    frontier = 0
    for begun, ended in sorted(intervals):
        tool_ms += max(0, ended - max(begun, frontier))
        frontier = max(frontier, ended)
    tools = []
    test_calls = 0
    first_edit = None
    for ts, payload in started:
        event = json.loads(payload)
        name = event.get('name', '')
        tools.append(name)
        args = event.get('input') or {}
        command = args.get('cmd', args.get('command', '')) if isinstance(args, dict) else ''
        if isinstance(command, str) and re.search(r'\b(vitest|pytest|typecheck|tsc|pnpm test|npm test)\b', command): test_calls += 1
        if any(token in name.lower() for token in ['apply_patch', 'edit', 'write_file']): first_edit = min(first_edit or ts, ts)
    return {'tools': tools, 'tool_ms': tool_ms, 'test_calls': test_calls, 'first_edit': first_edit, 'event_count': len(started)}

def member_activity(db, run, actor_id, actor, end):
    member = 'Lead' if actor_id == 'lead' else actor['input']['title']
    turns = [attempt for attempt in run['attempts'] if attempt['actorId'] == actor_id]
    tools = []
    tool_ms = 0
    test_calls = 0
    first_edit = None
    accepted = []
    ambiguous = 0
    details = []
    for attempt in turns:
        if not attempt.get('runId'): continue
        activity = attempt_tool_activity(db, attempt, end)
        tools.extend(activity['tools'])
        tool_ms += activity['tool_ms']
        test_calls += activity['test_calls']
        if activity['first_edit'] is not None: first_edit = min(first_edit or activity['first_edit'], activity['first_edit'])
        for receipt in attempt.get('liveDirections', []):
            if receipt['state'] == 'accepted': accepted.append((receipt['settledAt'] - receipt['createdAt']) / 1000)
            if receipt['state'] == 'uncertain': ambiguous += 1
        details.append((attempt['createdAt'], member, attempt.get('reason', 'assignment'), ((attempt.get('endedAt') or end) - attempt['createdAt']) / 1000, activity['event_count']))
    ambient = [attempt for attempt in turns if attempt.get('reason') == 'ambient']
    coordination = sum(any(token in name for token in ['team_say', 'team_status', 'team_wait', 'team_history', 'team_message', 'team_claim']) for name in tools)
    return {
        'member': member, 'turns': len(turns), 'ambient': len(ambient), 'silent': sum(attempt.get('outcome') == 'silent' for attempt in ambient),
        'turn_ms': sum((attempt.get('endedAt') or end) - attempt['createdAt'] for attempt in turns), 'tools': len(tools),
        'coordination': coordination, 'tool_ms': tool_ms, 'test_calls': test_calls, 'first_edit': first_edit,
        'accepted': accepted, 'ambiguous': ambiguous, 'details': details,
    }

def queued_delivery_delays(run):
    live_ids = {receipt['messageId'] for attempt in run['attempts'] for receipt in attempt.get('liveDirections', []) if receipt['state'] == 'accepted'}
    queued = []
    for message in run['messages']:
        if message['id'] in live_ids: continue
        attempt = next((attempt for attempt in run['attempts'] if attempt['id'] == message.get('attemptId')), None)
        if attempt: queued.append(max(0, attempt['createdAt'] - message['createdAt']) / 1000)
    return queued

def report(db, execution_id):
    run = journal(db, execution_id)
    if not run: raise SystemExit('Execution not found: ' + execution_id)
    actors = {actor['id']: actor for actor in run['actors']}
    start, end = run['createdAt'], run['updatedAt']
    print(f'\n## Execution {execution_id}\n\nState: {run["state"]}. Observed duration: {(end-start)/60000:.1f} minutes.')
    print('\n| Member | Turns | Ambient (silent) | Turn minutes¹ | Tools | Coordination tools | Tool minutes² | Test commands³ |\n|---|---:|---:|---:|---:|---:|---:|---:|')
    first_edit = None; accepted = []; ambiguous = 0; details = []
    for actor_id, actor in actors.items():
        activity = member_activity(db, run, actor_id, actor, end)
        accepted.extend(activity['accepted'])
        ambiguous += activity['ambiguous']
        details.extend(activity['details'])
        if activity['first_edit'] is not None: first_edit = min(first_edit or activity['first_edit'], activity['first_edit'])
        print(f'| {activity["member"]} | {activity["turns"]} | {activity["ambient"]} ({activity["silent"]}) | {activity["turn_ms"]/60000:.1f} | {activity["tools"]} | {activity["coordination"]} | {activity["tool_ms"]/60000:.1f} | {activity["test_calls"]} |')
    queued = queued_delivery_delays(run)
    print('\n¹ Sum of reservation-to-settlement elapsed time, overlapping across members; not pure inference time.\n² Union of matched tool start/end intervals within each attempt, not CPU time. Unmatched calls excluded.\n³ Shell calls whose direct cmd/command names a known test/typecheck command; excludes nested orchestration and is a lower bound.')
    print(f'\nMailbox deliveries: {len(run["messages"])}. Unique chat posts: {len(set(m.get("chatId",m["id"]) for m in run["messages"]))}.')
    print(f'First explicit edit tool: {((first_edit-start)/60_000):.1f} minutes after start.' if first_edit else 'No explicit edit tool observed (shell-based edits are not inferred).')
    for title,values in [('Accepted live transport acknowledgment (seconds)',accepted),('Queued message to reserved turn (seconds)',queued)]:
        print(f'{title}: n={len(values)}, median={statistics.median(values):.3f}, max={max(values):.3f}.' if values else title+': no samples.')
    print(f'Uncertain live receipts: {ambiguous}.')
    print('\n| Start offset | Member | Turn reason | Elapsed seconds | Tools |\n|---:|---|---|---:|---:|')
    for ts,name,reason,duration,count in sorted(details): print(f'| {(ts-start)/60_000:.1f}m | {name} | {reason} | {duration:.1f} | {count} |')
    print('\nLimitations: admission does not record when an actor first became runnable, so scheduling and workspace waits before reservation cannot be separated. Tool counts do not measure tool duration or prove useful work. Queued timing is reservation, not provider read or action. No delivery milestone proves semantic compliance.')

if __name__ == '__main__':
    if len(sys.argv)<3: raise SystemExit(__doc__)
    db=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True)
    for execution_id in sys.argv[2:]: report(db,execution_id)
