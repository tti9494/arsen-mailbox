import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker, { newId, newKey, nowSeconds, purge, sha256hex, sourceOf } from "../src/app";
import { dayStart } from "../src/budget";

const db = env.DB;
const bindings = { ...env, SOURCE_HASH_KEY: "maintenance-tests", KEY_EPOCH: "0", IMAGE_UPLOADS: "on" };
const makeRequest = (path: string, key: string, method = "GET") => new Request("https://mailbox.example.test" + path, {
  method, headers: {
    ...(key.startsWith("ams_") ? { authorization: "Bearer " + key } : { "x-mailbox-key": key }),
    "cf-connecting-ip": "198.51.100.4",
  },
});
const call = (path: string, key: string, method = "GET") => worker.fetch(makeRequest(path, key, method), bindings);
const count = (table: "rooms" | "messages" | "message_images" | "send_tickets", column: string, id: string) =>
  db.prepare("SELECT count(*) AS n FROM " + table + " WHERE " + column + "=?").bind(id).first<number>("n");

function setTime() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Math.floor(Date.now() / 60_000) * 60_000 + 10_000));
}
afterEach(() => vi.useRealTimers());

async function fixture() {
  const space = newId(), room = newId(), neighboringRoom = newId();
  const owner = newKey("ams_"), guest = newKey("amk_");
  const ownerSeat = newId(), guestSeat = newId();
  await db.batch([
    db.prepare("INSERT INTO spaces(id,key_hash,key_epoch,retention_days,created_at,last_seen_at) VALUES(?,?,0,NULL,unixepoch(),unixepoch())")
      .bind(space, await sha256hex(owner)),
    db.prepare("INSERT INTO rooms(id,owner_id,name,created_at) VALUES(?,?,'실험 방',unixepoch()),(?,?,'이웃 방',unixepoch())")
      .bind(room, space, neighboringRoom, space),
    db.prepare("INSERT INTO participants(id,room_id,name,kind,key_hash,is_owner,created_at,key_epoch) VALUES" +
      "(?,?,'방장','human',?,1,unixepoch(),0),(?,?,'게스트','human',?,0,unixepoch(),0),(?,?,'방장','human',?,1,unixepoch(),0)")
      .bind(ownerSeat, room, await sha256hex(newKey("internal_")), guestSeat, room, await sha256hex(guest),
        newId(), neighboringRoom, await sha256hex(newKey("internal_"))),
  ]);
  return { space, room, neighboringRoom, owner, guest, guestSeat, ownerSeat };
}

it("closes over-budget history immediately and deletes slices under the existing cleanup ceiling", async () => {
  setTime();
  const f = await fixture(), route = "/api/rooms/" + f.room;
  await db.prepare("WITH RECURSIVE generated(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM generated WHERE n<2502)" +
    " INSERT INTO messages(room_id,participant_id,body,body_hash,created_at) SELECT ?,?,'테스트 '||n,'x'||n,unixepoch() FROM generated")
    .bind(f.room, f.guestSeat).run();
  const image = await db.prepare("SELECT id FROM messages WHERE room_id=? ORDER BY id LIMIT 1").bind(f.room).first<number>("id");
  await db.batch([
    db.prepare("INSERT INTO message_images VALUES(?,?,?,'image/png',1,1,1,?,x'41',unixepoch())").bind(image, f.room, f.space, "a".repeat(64)),
    db.prepare("INSERT INTO send_tickets(ticket_hash,participant_id,created_at) VALUES('fixture',?,unixepoch())").bind(f.guestSeat),
  ]);
  expect((await call(route, f.guest, "DELETE")).status).toBe(403);
  const result = await call(route, f.owner, "DELETE");
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ deleted: true, cleanup_pending: true });
  expect((await call(route + "/messages", f.owner)).status).toBe(404);
  expect((await call(route + "/messages", f.guest)).status).toBe(403);
  expect((await call("/r/" + f.room + "/image/" + image, f.guest)).status).toBe(403);
  expect(await count("send_tickets", "participant_id", f.guestSeat)).toBe(0);
  const listed = await (await call("/api/rooms", f.owner)).json<{ rooms: { room_id: string }[] }>();
  expect(listed.rooms.map(({ room_id }) => room_id)).toEqual([f.neighboringRoom]);
  expect(await count("messages", "room_id", f.room)).toBe(2502);
  expect(await purge(bindings)).toBe(120);
  expect(await count("messages", "room_id", f.room)).toBe(2382);
  expect(await count("message_images", "room_id", f.room)).toBe(0);
  for (let step = 0; step < 25; step++) {
    if (step === 10) vi.setSystemTime(new Date((dayStart() + 86_400 + 10) * 1000));
    await purge(bindings);
  }
  expect(await count("rooms", "id", f.room)).toBe(0);
  expect(await count("rooms", "id", f.neighboringRoom)).toBe(1);
});

it("paces repeated rejected credentials after the source's daily cap without blocking valid credentials", async () => {
  setTime();
  const f = await fixture(), path = "/api/rooms/" + f.room + "/messages";
  const known = await call(path, f.guest);
  expect(known.status).toBe(200);
  const source = await sourceOf(makeRequest(path, f.guest), bindings);
  await db.prepare("INSERT INTO rate_hits(bucket,subject,window_start,count) VALUES('auth_fail_day',?,?,300)" +
    " ON CONFLICT(bucket,subject,window_start) DO UPDATE SET count=300").bind(source, dayStart()).run();
  const wrong = newKey("amk_");
  expect((await call(path, wrong)).status).toBe(429);
  const repeated = await call(path, wrong);
  expect(repeated.status).toBe(429);
  expect(repeated.headers.get("retry-after")).toBe("5");
  expect((await call(path, f.guest)).status).toBe(200);
  await db.prepare("UPDATE participants SET revoked=1 WHERE id=?").bind(f.guestSeat).run();
  expect((await call(path, f.guest)).status).toBe(429);
  expect(await db.prepare("SELECT count FROM rate_hits WHERE bucket='auth_fail_day' AND subject=? AND window_start=?")
    .bind(source, dayStart()).first("count")).toBe(300);
});

it("refreshes a stale global phase after one refusal and checks early while nearing the final threshold", async () => {
  setTime();
  const f = await fixture(), path = "/api/rooms/" + f.room + "/messages?since=0";
  await db.prepare("WITH RECURSIVE generated(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM generated WHERE n<51)" +
    " INSERT INTO messages(room_id,participant_id,body,body_hash,created_at) SELECT ?,?,'테스트 '||n,'recent:'||n,unixepoch() FROM generated")
    .bind(f.room, f.guestSeat).run();
  const sql: string[] = [];
  const observed = () => ({ prepare(query: string) {sql.push(query); return db.prepare(query);},
    batch: db.batch.bind(db) }) as D1Database;
  const setEstimate = (value: number) => db.prepare(
    "INSERT INTO rate_hits(bucket,subject,window_start,count) VALUES('estimated_writes','all',?,?)" +
    " ON CONFLICT(bucket,subject,window_start) DO UPDATE SET count=excluded.count",
  ).bind(dayStart(), value).run();
  const isHistory = () => sql.some(query => query.startsWith("WITH ") && query.includes(" FROM scanned_range"));
  async function inspect(database: D1Database) {
    sql.length = 0;
    return worker.fetch(makeRequest(path, f.owner), { ...bindings, DB: database });
  }
  const warmed = observed();
  expect((await inspect(warmed)).status).toBe(200);
  await setEstimate(70_000);
  expect((await inspect(warmed)).status).toBe(429);
  expect(isHistory()).toBe(true);
  expect((await inspect(warmed)).status).toBe(429);
  expect(isHistory()).toBe(false);
  const near = observed();
  await setEstimate(65_100);
  expect((await inspect(near)).status).toBe(200);
  await setEstimate(70_000);
  const stopped = await inspect(near);
  expect(stopped.status).toBe(429);
  expect(stopped.headers.get("retry-after")).toBe(String(86400 - nowSeconds() % 86400));
  expect(isHistory()).toBe(false);
});
