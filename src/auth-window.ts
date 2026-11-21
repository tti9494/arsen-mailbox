import { Refused } from "./policy";

const denied = new WeakMap<D1Database, Map<string, number>>();

export function rejectRecentlyDenied(db: D1Database, source: string, credential: string, now: number) {
  const until = denied.get(db)?.get(source + ":" + credential) ?? 0;
  if (until > now) throw new Refused("rate_limited", until - now);
}

// Save only proven-invalid attempts after the shared limiter refuses to charge another failure.
export function rememberDenied(db: D1Database, source: string, credential: string, now: number) {
  let entries = denied.get(db);
  if (!entries) {
    entries = new Map();
    denied.set(db, entries);
  }
  const key = source + ":" + credential;
  entries.delete(key);
  if (entries.size >= 1024) entries.delete(entries.keys().next().value!);
  entries.set(key, now + 5);
}
