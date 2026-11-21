export const SECONDS_PER_DAY = 86400;
export const HISTORY_PAGE = 50;
// The sentinel cannot be issued as a space ID or matched by an admin owner key.
export const CLOSED_ROOM_OWNER = "!closed-room";

export function retentionCutoff(days: number | null, now: number) {
  return days === null ? Number.MIN_SAFE_INTEGER : now - days * SECONDS_PER_DAY;
}

/** Safe ID floor for bounded history scans. The cutoff UTC day is included whole. */
export function historyStart(room: string, after: string, cutoff: string, now: string) {
  const today = `CAST(${now} AS INTEGER)/86400`;
  return `(CASE WHEN ${cutoff} >= (SELECT created_at FROM messages WHERE room_id=${room} AND id>${after} ORDER BY id LIMIT 1)
    AND (SELECT created_at/86400 FROM messages INDEXED BY messages_room_day WHERE room_id=${room}
      ORDER BY created_at/86400 DESC LIMIT 1)<=${today}
    THEN (WITH RECURSIVE days(day) AS (SELECT CAST(${cutoff} AS INTEGER)/86400 UNION ALL SELECT day+1 FROM days WHERE day<${today})
      SELECT COALESCE(MIN((SELECT id FROM messages INDEXED BY messages_room_day
        WHERE room_id=${room} AND created_at/86400=days.day AND id>${after} ORDER BY id LIMIT 1))-1,
        (SELECT MAX(id) FROM messages WHERE room_id=${room}),${after}) FROM days)
    ELSE ${after} END)`;
}

export function historyWindow<T extends { id: number }>(rows: T[], scanned: number, scanEnd: number, start: number, size = HISTORY_PAGE) {
  const page = rows.slice(0, size);
  return {
    page,
    more: scanned > size,
    next: rows.length > size ? page.at(-1)!.id : Math.max(start, scanEnd),
  };
}

export function historyScan(room: string, start: string, cutoff: string, now: string, until = "9223372036854775807",
  size = HISTORY_PAGE, seek = true) {
  return `scanned AS MATERIALIZED (SELECT id,created_at FROM messages
    WHERE room_id=${room} AND id>${seek ? historyStart(room, start, cutoff, now) : start} AND id<=${until}
    ORDER BY id LIMIT ${size + 1}),
    scanned_range AS (SELECT count(*) AS scanned_count,COALESCE(MAX(id),${start}) AS scan_end FROM scanned),
    retained AS MATERIALIZED (SELECT id FROM scanned WHERE created_at>${cutoff})`;
}

export function historyTail(room: string, before: string, cutoff: string, now: string, size: number, seek: boolean) {
  const today = `CAST(${now} AS INTEGER)/86400`;
  const upper = seek ? `(CASE WHEN ${cutoff}>=(SELECT created_at FROM messages WHERE room_id=${room} AND id<${before} ORDER BY id DESC LIMIT 1)
    AND (SELECT created_at/86400 FROM messages INDEXED BY messages_room_day WHERE room_id=${room}
      ORDER BY created_at/86400 DESC LIMIT 1)<=${today}
    THEN (WITH RECURSIVE days(day) AS (SELECT CAST(${cutoff} AS INTEGER)/86400 UNION ALL SELECT day+1 FROM days WHERE day<${today})
      SELECT COALESCE(MAX((SELECT id FROM messages INDEXED BY messages_room_day
        WHERE room_id=${room} AND created_at/86400=days.day AND id<${before} ORDER BY id DESC LIMIT 1))+1,0) FROM days)
    ELSE ${before} END)` : before;
  return `scanned AS MATERIALIZED (SELECT id,created_at FROM messages WHERE room_id=${room} AND id<${upper}
    ORDER BY id DESC LIMIT ${size + 1}),
    scanned_range AS (SELECT count(*) AS scanned_count,COALESCE(MIN(id),0) AS scan_end FROM scanned),
    retained AS MATERIALIZED (SELECT id FROM scanned WHERE created_at>${cutoff})`;
}

/** Tie each read/write to the policy used to select content, including across a concurrent policy edit. */
export function retentionGuard(db: D1Database, spaceId: string, days: number | null, revision: number) {
  return db.prepare("INSERT INTO retention_assertion(failure) SELECT 'policy_changed'" +
    " WHERE NOT EXISTS(SELECT 1 FROM spaces WHERE id=? AND retention_days IS ? AND retention_rev=?)")
    .bind(spaceId, days, revision);
}
