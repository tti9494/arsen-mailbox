import { DailyCapacity, dayStart, readWriteEstimate, reserveBulk, roomDeletionCost } from "./budget";
import { CLOSED_ROOM_OWNER, SECONDS_PER_DAY } from "./retention";
import { refusal } from "./transaction";

const PAGE = 120;
const MESSAGE_SCAN = 480;
const SPACE_SCAN = 32;
const CRON_CEILING = 45_000;
const joins = " FROM messages m JOIN rooms r ON r.id=m.room_id LEFT JOIN spaces s ON s.id=r.owner_id";
const deadSpace = "s.status='deleted' AND s.deleted_at<=?1-86400";
const discarded = "(" + deadSpace + " OR r.owner_id='" + CLOSED_ROOM_OWNER + "')";
const expired = "(" + discarded +
  " OR (m.created_at<=?1-7*86400 AND m.created_at<=CASE WHEN s.id IS NULL THEN ?1-30*86400 ELSE ?1-s.retention_days*86400 END))";
const cursor = (key: string) => `COALESCE((SELECT value FROM mailbox_meta WHERE key='${key}'),0)`;
const setCursor = (db: D1Database, key: string, value: number) => db.prepare(
  "INSERT INTO mailbox_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value",
).bind(key, value);

export async function maintain(db: D1Database, now: number): Promise<number> {
  const day = dayStart();
  let removed = 0;
  try {
    const estimate = await readWriteEstimate(db, day);
    if (estimate >= CRON_CEILING) return 0;
    const { results, meta } = await db.prepare(
      "WITH scan AS MATERIALIZED (SELECT id FROM messages WHERE id>" + cursor("sweep_messages") +
      " ORDER BY id LIMIT ?2)" +
      " SELECT m.id,m.room_id," + discarded + " AS dead," +
      " CASE WHEN " + expired + " THEN 12+CASE WHEN " + discarded + " THEN 8 ELSE 0 END" +
      " +8*(SELECT count(*) FROM question_targets WHERE question_id=m.id)" +
      " +12*EXISTS(SELECT 1 FROM message_images WHERE message_id=m.id)" +
      " +12*(SELECT count(*) FROM question_targets WHERE reply_id=m.id) ELSE 0 END AS cost" +
      " FROM scan CROSS JOIN messages m ON m.id=scan.id CROSS JOIN rooms r ON r.id=m.room_id" +
      " LEFT JOIN spaces s ON s.id=r.owner_id ORDER BY m.id",
    ).bind(now, MESSAGE_SCAN).all<{ id: number; room_id: string; dead: number; cost: number }>();
    const ids: number[] = [];
    const visited: number[] = [];
    const rooms = new Set<string>();
    let cost = 6 + Math.ceil(meta.rows_read / 50);
    for (const row of results) {
      if (row.cost && (ids.length >= PAGE || cost + row.cost > Math.min(4000, CRON_CEILING - estimate))) break;
      visited.push(row.id);
      if (!row.cost) continue;
      if (row.dead) rooms.add(row.room_id);
      ids.push(row.id);
      cost += row.cost;
    }
    const advance = visited.length === results.length && results.length < MESSAGE_SCAN ? 0 : visited.at(-1);
    if (advance !== undefined) {
      const set = "m.id IN (SELECT value FROM json_each(?2))";
      const selected = JSON.stringify(ids);
      const visitedIds = JSON.stringify(visited);
      const orphaned = "id IN (SELECT value FROM json_each(?)) AND reply_to IS NOT NULL" +
        " AND (NOT EXISTS(SELECT 1 FROM messages parent WHERE parent.id=messages.reply_to)" +
        " OR reply_to IN (SELECT value FROM json_each(?)))";
      const result = await db.batch([
        ...reserveBulk(db, day, CRON_CEILING,
          "?+4*(SELECT count(*) FROM messages WHERE " + orphaned + ")", cost, visitedIds, selected),
        db.prepare("INSERT OR IGNORE INTO explicit_room_deletion(room_id) SELECT DISTINCT m.room_id" +
          joins + " WHERE " + set + " AND " + discarded).bind(now, selected),
        db.prepare("DELETE FROM messages WHERE id IN (SELECT m.id" + joins + " WHERE " + set + " AND " + expired + ") RETURNING id")
          .bind(now, selected),
        db.prepare("DELETE FROM explicit_room_deletion WHERE room_id IN (SELECT value FROM json_each(?))")
          .bind(JSON.stringify([...rooms])),
        db.prepare("UPDATE messages SET reply_to=NULL WHERE id IN (SELECT value FROM json_each(?)) AND reply_to IS NOT NULL" +
          " AND NOT EXISTS(SELECT 1 FROM messages parent WHERE parent.id=messages.reply_to)").bind(visitedIds),
        setCursor(db, "sweep_messages", advance),
      ]);
      removed = result[3].results.length;
    }

    const dead = await db.prepare("WITH scan AS MATERIALIZED (SELECT rowid,id,status,deleted_at FROM spaces WHERE rowid>" +
      cursor("sweep_spaces") + " ORDER BY rowid LIMIT ?2)" +
      " SELECT rowid,id,status='deleted' AND deleted_at<=?1 AS eligible FROM scan ORDER BY rowid",
    ).bind(now - SECONDS_PER_DAY, SPACE_SCAN).all<{ rowid: number; id: string; eligible: number }>();
    const eligible = dead.results.filter((row) => row.eligible).map((row) => row.id);
    const candidates = JSON.stringify(eligible);
    const tickets = "SELECT rowid FROM send_tickets WHERE created_at<=? ORDER BY created_at LIMIT " + PAGE;
    const rates = "SELECT rowid FROM (SELECT rowid FROM rate_hits WHERE window_start<=? ORDER BY window_start LIMIT " + PAGE +
      ") UNION SELECT rowid FROM (SELECT rowid FROM rate_hits INDEXED BY rate_auth_cleanup" +
      " WHERE bucket IN ('auth_fail','auth_fail_day') AND window_start<? ORDER BY window_start LIMIT " + PAGE + ") LIMIT " + PAGE;
    const sourceRows = "SELECT id FROM spaces WHERE created_ip_hash IS NOT NULL AND created_at<? ORDER BY created_at LIMIT " + PAGE;
    const ended = "SELECT id FROM spaces WHERE id IN (SELECT value FROM json_each(?)) AND status='deleted'" +
      " AND NOT EXISTS(SELECT 1 FROM rooms WHERE owner_id=spaces.id)";
    const overhead = [tickets, rates, sourceRows, ended].map((q, i) => [8, 10, 8, 16][i] +
      "*(SELECT count(*) FROM (" + q + "))").join("+");
    const readCost = 16 + Math.ceil((dead.meta.rows_read + eligible.length * 127) / 50);
    await db.batch([
      ...reserveBulk(db, day, CRON_CEILING, "?+" + overhead, readCost, now - 1800, now - 2 * SECONDS_PER_DAY, day, day, candidates),
      db.prepare("DELETE FROM send_tickets WHERE rowid IN (" + tickets + ")").bind(now - 1800),
      db.prepare("DELETE FROM rate_hits WHERE rowid IN (" + rates + ")").bind(now - 2 * SECONDS_PER_DAY, day),
      db.prepare("UPDATE spaces SET created_ip_hash=NULL WHERE id IN (" + sourceRows + ")").bind(day),
      db.prepare("DELETE FROM spaces WHERE id IN (" + ended + ")").bind(candidates),
      setCursor(db, "sweep_spaces", dead.results.length < SPACE_SCAN ? 0 : dead.results.at(-1)!.rowid),
    ]);

    // Retired rooms can be removed once their old messages have drained in bounded pages.
    const closedEmpty = await db.prepare(
      "SELECT room.id FROM (SELECT id FROM rooms WHERE owner_id=? ORDER BY rowid LIMIT ?)" +
      " room WHERE NOT EXISTS(SELECT 1 FROM messages WHERE room_id=room.id) LIMIT 1",
    ).bind(CLOSED_ROOM_OWNER, SPACE_SCAN).first<string>("id");
    const retired = closedEmpty ?? (eligible.length ? await db.prepare(
      "SELECT r.id FROM json_each(?2) candidate CROSS JOIN spaces s ON s.id=candidate.value" +
      " CROSS JOIN rooms r ON r.owner_id=s.id WHERE " + deadSpace +
      " AND NOT EXISTS(SELECT 1 FROM messages WHERE room_id=r.id) LIMIT 1",
     ).bind(now, candidates).first<string>("id") : null);
    if (retired) await db.batch([
      ...reserveBulk(db, day, CRON_CEILING, roomDeletionCost, retired, retired, retired),
      db.prepare("DELETE FROM rooms WHERE id=? AND NOT EXISTS(SELECT 1 FROM messages WHERE room_id=?)").bind(retired, retired),
    ]);
    return removed;
  } catch (e) {
    if (refusal(e) instanceof DailyCapacity) return removed;
    throw e;
  }
}
