import { SPACE_LIMITS } from "./brand";
import { Refused } from "./policy";

export const dayStart = () => Math.floor(Date.now() / 86_400_000) * 86400;
export const dayCount =
  "(SELECT COALESCE(MAX(count),0) FROM rate_hits WHERE bucket=? AND subject=? AND window_start=?)";

// Frequent authenticated operations are charged in the same space row used for admission.
export const estimatedWrites = "(" + dayCount +
  "+(SELECT COALESCE(SUM(request_write_estimate),0) FROM spaces WHERE request_day=?))";
export const estimateBindings = (day: number) => ["estimated_writes", "all", day, day] as const;
export const STOP_MUTATIONS = SPACE_LIMITS.signup_stop_writes;
export const SLOW_READS = 65_000;
export const STOP_TRAFFIC = 70_000;
export const SIGNUP_WRITE_WEIGHT = 48;
export const DEFAULT_SPACE_DAILY_WRITE_LIMIT = 24_000;
export function spaceDailyWriteLimit(value?: string) {
  const input = value?.trim();
  if (!input || !/^[+-]?\d+$/.test(input)) return DEFAULT_SPACE_DAILY_WRITE_LIMIT;
  return Math.min(30_000, Math.max(1_000, Number(input)));
}
export const FEEDBACK_WRITE_WEIGHT = 12;
export const DAILY_CAPACITY_NOTICE = "오늘 우편함 사용량 한도에 도달했습니다. UTC 자정(한국 시각 오전 9시) 이후 다시 시도해 주세요.";

export class DailyCapacity extends Refused {
  constructor(now = Math.floor(Date.now() / 1000), readonly scope: "service_day" | "space_day" | "space_operation" = "service_day") {
    super("quota", scope === "space_operation" ? undefined : 86400 - now % 86400);
  }

  get notice() {
    if (this.scope === "service_day") return DAILY_CAPACITY_NOTICE;
    if (this.scope === "space_operation")
      return "이 작업 한 건이 공간의 하루 처리 한도를 넘습니다. 참가자 폐기는 나눠서 진행하고, 큰 방 삭제는 운영자에게 문의해 주세요.";
    return "이 공간의 오늘 사용량 한도에 도달했습니다. UTC 자정(한국 시각 오전 9시) 이후 다시 시도해 주세요.";
  }
}

export const capStage = (estimate: number) =>
  estimate >= STOP_TRAFFIC ? "closed" : estimate >= SLOW_READS ? "slow_reads" :
    estimate >= STOP_MUTATIONS ? "read_only" : "normal";

export async function readWriteEstimate(db: D1Database, start = dayStart()) {
  return (await db.prepare("SELECT " + estimatedWrites + " AS estimate")
    .bind(...estimateBindings(start)).first<number>("estimate")) ?? 0;
}

type CapacitySnapshot = { estimate: number; active_spaces: number };
export function pollCharge(activeSpaces: number, scannedMessages: number) {
  // Each admission touches the shared estimator. At larger tenant counts the read ceiling can bind first.
  return Math.max(2, Math.ceil((20 + 4 * activeSpaces + scannedMessages) / 50));
}

export type WriteCost = number | readonly [string, ...(string | number)[]];

export function budgetGuard(db: D1Database, start: number, available: number, cost: WriteCost) {
  const [sql, ...args] = typeof cost === "number" ? ["?", cost] : cost;
  return db.prepare("INSERT INTO capacity_assertion(failure) SELECT 'daily_capacity' WHERE " +
    estimatedWrites + "+(" + sql + ")>?").bind(...estimateBindings(start), ...args, available);
}

export async function requireCapacity(db: D1Database, available: number, cost = 1) {
  if (await readWriteEstimate(db) + cost > available) throw new DailyCapacity();
}

export function addWriteEstimate(db: D1Database, start: number, estimate: number, afterChange = false) {
  return db.prepare(
    "INSERT INTO rate_hits(bucket,subject,window_start,count) SELECT 'estimated_writes','all',?,? WHERE " +
      (afterChange ? "changes()=1" : "1") +
      " ON CONFLICT(bucket,subject,window_start) DO UPDATE SET count=count+excluded.count",
  ).bind(start, estimate);
}

/** A variable-size operation reserves its charge using the same D1 snapshot as the mutation. */
export function reserveBulk(
  db: D1Database, start: number, limit: number, cost: string, ...values: (string | number)[]
) {
  return [
    db.prepare("INSERT INTO capacity_assertion(failure) SELECT 'daily_capacity' WHERE " +
      estimatedWrites + "+(" + cost + ")>?").bind(...estimateBindings(start), ...values, limit),
    db.prepare("INSERT INTO rate_hits(bucket,subject,window_start,count) VALUES('estimated_writes','all',?,(" + cost + "))" +
      " ON CONFLICT(bucket,subject,window_start) DO UPDATE SET count=count+excluded.count")
      .bind(start, ...values),
  ];
}

const DELETE_SCAN = 2501; // 2,501 messages alone exceed the maximum space reservation.
export const roomDeletionCost = `(WITH history AS MATERIALIZED (
  SELECT id FROM messages WHERE room_id=? ORDER BY id LIMIT ${DELETE_SCAN}
) SELECT CASE WHEN (SELECT count(*) FROM history)=${DELETE_SCAN} THEN ${12 * DELETE_SCAN} ELSE
  24+12*(SELECT count(*) FROM history)
  +8*(SELECT count(*) FROM (SELECT 1 FROM history h CROSS JOIN question_targets t ON t.question_id=h.id LIMIT ${DELETE_SCAN}))
  +8*(SELECT count(*) FROM (SELECT 1 FROM history h CROSS JOIN question_targets t ON t.reply_id=h.id LIMIT ${DELETE_SCAN}))
  +12*(SELECT count(*) FROM history h CROSS JOIN message_images i ON i.message_id=h.id)
  +16*(SELECT count(*) FROM participants WHERE room_id=?)
  +8*(SELECT count(*) FROM participants p CROSS JOIN send_tickets t ON t.participant_id=p.id WHERE p.room_id=?) END)`;

export const spaceRevocationCost = "32+(SELECT COALESCE(SUM(2+12*(p.revoked=0)),0) FROM rooms r" +
  " CROSS JOIN participants p ON p.room_id=r.id WHERE r.owner_id=?)" +
  "+8*(SELECT count(*) FROM rooms r CROSS JOIN participants p ON p.room_id=r.id" +
  " CROSS JOIN send_tickets t ON t.participant_id=p.id WHERE r.owner_id=?)";
const pressureCache = new WeakMap<D1Database, { window: number; pending: Promise<CapacitySnapshot> }>();
export function refreshCapacityOnRefusal(db: D1Database, reason: DailyCapacity) {
  if (reason.scope === "service_day") pressureCache.delete(db);
}
export function recentCapacity(db: D1Database, now: number) {
  const window = Math.floor(now / 60);
  const cached = pressureCache.get(db);
  if (cached?.window === window) return cached.pending;
  const start = Math.floor(now / 86400) * 86400;
  const pending = db.prepare("SELECT " + dayCount + "+COALESCE(SUM(request_write_estimate),0) AS estimate," +
    " count(*) AS active_spaces FROM spaces WHERE request_day=?")
    .bind(...estimateBindings(start)).first<CapacitySnapshot>().then(snapshot => snapshot!)
    .catch(error => {
      if (pressureCache.get(db)?.window === window) pressureCache.delete(db);
      throw error;
    });
  pressureCache.set(db, { window, pending });
  return pending;
}
