import { LIMITS, Refused } from "./policy";
import { requireSql, refusal } from "./transaction";
import { addWriteEstimate, budgetGuard, DailyCapacity, STOP_TRAFFIC, type WriteCost } from "./budget";

const day = (now: number) => now - now % 86400;
export const minute = (now: number) => now - now % 60;

export type CredentialRepair = "revoke" | "recover";
const SPACE_SECURITY_RESERVE = 6_000;
const SPACE_SECURITY_REQUEST_RESERVE = 100;
const repairOnly = { points: 100, requests: 5 };
const spaceRequestLimit = (repair?: CredentialRepair) =>
  LIMITS.space_day[0] + (repair ? SPACE_SECURITY_REQUEST_RESERVE - (repair === "revoke" ? repairOnly.requests : 0) : 0);

export type SpaceReadUsage = {
  request_day: number;
  request_count: number;
  request_write_estimate: number;
  request_minute: number;
  request_minute_count: number;
};

// Reject from the authenticated snapshot first. The later transaction is authoritative under concurrency.
export function spaceReadHeadroom(usage: SpaceReadUsage, now: number, owner: boolean, allocation: number, minimum: number) {
  const today = day(now);
  if (usage.request_day === today && usage.request_count >= spaceRequestLimit())
    throw new Refused("rate_limited", 86400 - now % 86400);
  if (owner && usage.request_minute === minute(now) && usage.request_minute_count >= LIMITS.space[0])
    throw new Refused("rate_limited", 60 - now % 60);
  const remaining = allocation - (usage.request_day === today ? usage.request_write_estimate : 2);
  if (remaining < minimum) throw new DailyCapacity(now, "space_day");
  return remaining;
}

export function spaceLimit(
  db: D1Database, space: string, now: number, owner: boolean, writeEstimate: WriteCost,
  ceiling: number, allocation: number, repair?: CredentialRepair,
) {
  const today = day(now);
  // A leaked owner key can invoke revocations, but cannot spend the last part of the recovery reserve.
  const limit = allocation + (repair === "recover" ? SPACE_SECURITY_RESERVE :
    repair === "revoke" ? SPACE_SECURITY_RESERVE - repairOnly.points : 0);
  const window = minute(now);
  const condition = "(request_day!=? OR request_count<?)" +
    (owner ? " AND (request_minute!=? OR request_minute_count<?)" : "");
  const rateGuard = requireSql(db, "rate_limited",
    "EXISTS(SELECT 1 FROM spaces WHERE id=? AND " + condition + ")",
    space, today, spaceRequestLimit(repair), ...(owner ? [window, LIMITS.space[0]] : []));
  const [cost, ...args] = typeof writeEstimate === "number" ? ["?", writeEstimate] : writeEstimate;
  const spent = "(SELECT COALESCE(MAX(request_write_estimate),0) FROM spaces WHERE id=? AND request_day=?)";
  const rollover = "2*NOT EXISTS(SELECT 1 FROM spaces WHERE id=? AND request_day=?)";
  const charge: WriteCost = [`(${cost})+(${rollover})`, ...args, space, today];
  const capacity = db.prepare(
    "INSERT INTO capacity_assertion(failure) SELECT CASE WHEN (" + cost + ")>?" +
      " THEN 'space_operation_capacity' ELSE 'space_daily_capacity' END WHERE " +
      spent + "+(" + charge[0] + ")>?",
  ).bind(...args, limit, space, today, ...charge.slice(1), limit);
  const ownerUpdate =
    owner ? ",request_minute_count=CASE WHEN request_minute=? THEN request_minute_count+1 ELSE 1 END,request_minute=?" : "";
  const ownerArgs = owner ? [window, window] : [];
  const stable = db.prepare(
    "UPDATE spaces SET request_count=request_count+1,request_write_estimate=request_write_estimate+(" + cost + ")" +
      ownerUpdate + " WHERE id=? AND request_day=?",
  ).bind(...args, ...ownerArgs, space, today);
  const next = db.prepare(
    "UPDATE spaces SET request_count=1,request_write_estimate=(" + cost + ")+2,request_day=?" +
      ownerUpdate + " WHERE id=? AND request_day!=?",
  ).bind(...args, today, ...ownerArgs, space, today);
  const global = budgetGuard(db, today, ceiling, charge);
  const guards = typeof writeEstimate === "number" ? [global, rateGuard, capacity] : [capacity, global, rateGuard];
  // Try the current date first so the rollover cannot also take that branch.
  return { guards, updates: [stable, next] };
}

export async function spaceRateError(
  db: D1Database, space: string, now: number, e: unknown, repair?: CredentialRepair,
): Promise<never> {
  const reason = refusal(e);
  if (reason?.code !== "rate_limited") throw reason ?? e;
  const row = await db.prepare("SELECT request_day,request_count FROM spaces WHERE id=?")
    .bind(space).first<{ request_day: number; request_count: number }>();
  const window = row?.request_day === day(now) && row.request_count >= spaceRequestLimit(repair) ? 86400 : 60;
  throw new Refused("rate_limited", window - (now % window));
}

export async function takeSpaceLimit(
  db: D1Database, space: string, now: number, owner: boolean, writeEstimate: number,
  ceiling: number, allocation: number, repair?: CredentialRepair,
) {
  const scope = spaceLimit(db, space, now, owner, writeEstimate, ceiling, allocation, repair);
  await db.batch([...scope.guards, ...scope.updates]).catch(e => spaceRateError(db, space, now, e, repair));
}

export function participantReadGuard(db: D1Database, id: string, now: number) {
  return requireSql(db, "rate_limited",
    "EXISTS(SELECT 1 FROM participants WHERE id=? AND (read_minute!=? OR read_count<?))",
    id, minute(now), LIMITS.read[0]);
}

export async function takeParticipantRead(db: D1Database, id: string, now: number, space: string | null, allocation: number, readCost: number) {
  const scope = space ? spaceLimit(db, space, now, false, readCost, STOP_TRAFFIC, allocation) : null;
  const results = await db.batch([
    participantReadGuard(db, id, now),
    ...(scope ? [...scope.guards, ...scope.updates] : [
      budgetGuard(db, day(now), STOP_TRAFFIC, 3), addWriteEstimate(db, day(now), 3),
    ]),
    db.prepare("UPDATE participants SET read_count=CASE WHEN read_minute=?2 THEN read_count+1 ELSE 1 END,read_minute=?2 WHERE id=?1")
      .bind(id, minute(now)),
  ]).catch(e => { throw refusal(e) ?? e; });
  if (results.at(-1)?.meta.changes !== 1) throw new Refused("forbidden");
}
