import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { newKey, purge, sourceOf, sha256hex, type Env } from "../src/app";
import { dayStart, readWriteEstimate } from "../src/budget";
import { LIMITS } from "../src/policy";
import { SIGNUP_WRITE_WEIGHT, SLOW_READS, DEFAULT_SPACE_DAILY_WRITE_LIMIT, STOP_MUTATIONS, STOP_TRAFFIC } from "../src/budget";
import { SPACE_LIMITS } from "../src/brand";
import { migrateOwnerRows } from "../src/migrate-owner-rows";
import { routeQuestion, type QuestionState, type RelayTurn } from "../src/questions";

const local = {
  ...env,
  KEY_EPOCH: "0",
  SIGNUP_OPEN: "invite",
  SOURCE_HASH_KEY: "source-hash-test-fixture",
  TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
};
const db = env.DB;
const invite = newKey("ami_");
const testToken = "XXXX.DUMMY.TOKEN.XXXX";
type Reply = {
  active_participants: number;
  revoked_count: number;
  space_id: string;
  key: string;
  recovery_codes: string[];
  room_id: string;
  participant_id: string;
  ai_type: string;
  delivery: string;
  interval_minutes: number;
  assistant_text: string;
  connection_text: string;
  human_link: string;
  owner_participant_id: string;
  error: string;
  retry_after: number;
  id: number;
  questions: QuestionState[];
  relay_turns: RelayTurn[];
  room_limit: number;
  participant_limit: number;
  retention_days: number | null;
  avatar_preset: string | null;
  avatar_rev: string;
  avatars: { revision: string; webp: string }[];
  chunk: string;
  next: number;
  previous: number | null;
  until: number;
  more: boolean;
  policy: string;
  usage: { messages_today: number };
  rooms: { room_id: string; last_message: string; unread_count: number }[];
  participants: {
    participant_id: string;
    name: string;
    device_label?: string | null;
    role_note?: string | null;
    kind: string;
    ai_type: string | null;
    delivery: string;
    interval_minutes: number;
    status: string;
    is_owner: boolean;
    issued_at_message_id: number;
    first_read_at: number | null;
    last_read_at: number | null;
    last_seen_at: number | null;
  }[];
  messages: { id: number; text: string; participant_id: string; relayed_for: string | null; relay_label: string | null }[];
};
function call(path: string, method = "GET", key?: string, body?: unknown, bindings: Env = local) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key?.startsWith("amk_")) headers["x-mailbox-key"] = key;
  else if (key) headers.authorization = "Bearer " + key;
  return worker.fetch(
    new Request("http://127.0.0.1" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    bindings,
  );
}
async function ok(response: Promise<Response>) {
  const r = await response;
  expect(r.status).toBe(200);
  return r.json<Reply>();
}
async function denied(response: Promise<Response>, status: number, code: string) {
  const r = await response;
  expect(r.status).toBe(status);
  expect((await r.json<Reply>()).error).toBe(code);
}
const signup = (bindings: Env = local) => call("/api/spaces", "POST", undefined, { invite, turnstile: testToken }, bindings);
const room = (key: string) => ok(call("/api/rooms", "POST", key, { name: "회의실" }));
const member = (id: string, key: string, name = "비서", kind = "assistant", delivery = "header") =>
  ok(call(`/api/rooms/${id}/participants`, "POST", key, { name, kind, delivery }));
const recover = (code: string) => call("/api/spaces/recover", "POST", undefined, { code, turnstile: testToken });
beforeEach(async () => {
  await db.batch(
    ["DELETE FROM spaces", "DELETE FROM invite_codes", "DELETE FROM rate_hits", "DELETE FROM mailbox_meta"].map((sql) =>
      db.prepare(sql),
    ),
  );
  await db
    .prepare(
      "INSERT INTO invite_codes(code_hash,created_at,max_uses,expires_at) VALUES(?,unixepoch(),20,unixepoch()+300)",
    )
    .bind(await sha256hex(invite))
    .run();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, options: RequestInit) => {
      expect(input).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
      expect(options.method).toBe("POST");
      return Response.json({ success: (options.body as URLSearchParams).get("response") === testToken });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("blocks enrollment and recovery before Siteverify when the source hash key is unavailable", async () => {
  const owner = await ok(signup());
  vi.mocked(fetch).mockClear();
  for (const SOURCE_HASH_KEY of [undefined, " "]) {
    const unconfigured = { ...local, SOURCE_HASH_KEY };
    await denied(signup(unconfigured), 403, "forbidden");
    await denied(call("/api/spaces/recover", "POST", undefined, {
      code: owner.recovery_codes[0], turnstile: testToken,
    }, unconfigured), 403, "forbidden");
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(await db.prepare("SELECT count(*) AS n FROM spaces").first("n")).toBe(1);
  await ok(recover(owner.recovery_codes[0]));
});

describe("assistant defaults", () => {
  it("applies the catalog to new participants and gives a delivery-accurate instruction", async () => {
    const owner = await ok(signup());
    const rooms = [await room(owner.key), await room(owner.key)];
    const expected = [
      ["vooy", "get", 1], ["keyring", "get", 5], ["cue", "get", 5], ["muse", "get", 5],
      ["instinct", "get", 5], ["pickle", "header", 5], ["claude", "header", 10],
      ["chatgpt", "header", 10], ["gemini", "header", 10], ["other", "header", 10], ["hark", "header", 10],
    ] as const;
    for (const [i, [ai_type, delivery, interval_minutes]] of expected.entries()) {
      const path = "/api/rooms/" + rooms[i % 2].room_id + "/participants";
      const res = await ok(call(path, "POST", owner.key, { name: ai_type, kind: "assistant", ai_type }));
      expect(res).toMatchObject({ delivery, interval_minutes });
      if (ai_type === "vooy") {
        expect(res.connection_text).toContain("Google 캘린더 감시를 설정한 경우, 1분 간격");
        expect(res.connection_text).toContain("‘우편함 호출’ 이벤트");
        expect(res.connection_text).toContain("주소(GET) 방식으로 한 번 읽고 답한 뒤 캘린더 감시로 돌아가세요");
      }
      if (ai_type === "hark") {
        expect(res.connection_text).toContain("직접 답 옮기기");
        expect(res.connection_text).not.toContain(res.key);
      }
    }
    const guest = await member(rooms[0].room_id, owner.key, "손님", "human");
    expect(guest.connection_text).toBe(guest.human_link);
  });

  it("remembers per space, checks authority, and keeps explicit per-participant settings on reissue", async () => {
    const a = await ok(signup()), b = await ok(signup());
    const [r, neighbor, other] = await Promise.all([room(a.key), room(a.key), room(b.key)]);
    const add = (roomId: string, key: string, name: string, fields = {}) =>
      ok(call("/api/rooms/" + roomId + "/participants", "POST", key, { name, kind: "assistant", ai_type: "vooy", ...fields }));
    const path = "/api/me/assistant-defaults";
    const preset = { ai_type: "vooy", delivery: "header", interval_minutes: 17 };
    const existing = await add(r.room_id, a.key, "기존 부이", { delivery: "get", interval_minutes: 30 });
    const guest = await member(r.room_id, a.key, "손님", "human");
    await denied(call(path, "PATCH", guest.key, preset), 403, "forbidden");
    await denied(call(path, "PATCH", undefined, preset), 401, "unauthorized");
    await denied(call(path, "PATCH", a.key, { ...preset, ai_type: "hark" }), 400, "invalid");
    await denied(call(path, "PATCH", a.key, { ...preset, space_id: b.space_id }), 400, "invalid");
    await ok(call(path, "PATCH", a.key, preset));
    await ok(call(path, "PATCH", a.key, { ai_type: "cue", delivery: "get", interval_minutes: 25 }));
    const remembered = await (await call("/api/me", "GET", a.key)).json<{ assistant_defaults: object }>();
    expect(remembered.assistant_defaults).toEqual({ vooy: { delivery: "header", interval_minutes: 17 }, cue: { delivery: "get", interval_minutes: 25 } });
    expect(await add(other.room_id, b.key, "다른 공간 부이")).toMatchObject({ delivery: "get", interval_minutes: 1 });
    const newer = await add(neighbor.room_id, a.key, "기억된 부이");
    expect(newer).toMatchObject({ delivery: "header", interval_minutes: 17 });
    expect(newer.connection_text).toContain("17분 간격으로 감시하세요(부이 기본 1분)");
    expect(newer.connection_text).toContain("헤더 방식으로 한 번 읽고 답한 뒤");
    expect(newer.connection_text).not.toContain("/read?k=");
    expect(await add(neighbor.room_id, a.key, "직접 입력 부이", { interval_minutes: 8, delivery: "get" })).toMatchObject({ delivery: "get", interval_minutes: 8 });
    const participant = "/api/rooms/" + r.room_id + "/participants/" + existing.participant_id;
    await ok(call(participant, "PATCH", a.key, { interval_minutes: 19 }));
    expect(await ok(call(participant + "/reissue", "POST", a.key, {}))).toMatchObject({ delivery: "get", interval_minutes: 19 });
  });
});

describe("space admission and credentials", () => {
  it("requires both gates, validates Siteverify and rejects missing configuration or bad epochs", async () => {
    await denied(signup({ ...local, SIGNUP_OPEN: "off" }), 503, "signup_closed");
    await denied(signup({ ...local, SIGNUP_OPEN: "unknown" }), 503, "signup_closed");
    await denied(signup({ ...local, KEY_EPOCH: "closed" }), 503, "key_epoch_invalid");
    await denied(signup({ ...local, TURNSTILE_SECRET: "" }), 403, "forbidden");
    await denied(call("/api/spaces", "POST", undefined, { invite, turnstile: "wrong-token" }), 403, "forbidden");
    await denied(
      call(
        "/api/spaces",
        "POST",
        undefined,
        { invite: "wrong", turnstile: testToken },
        { ...local, SIGNUP_OPEN: "on" },
      ),
      403,
      "forbidden",
    );
    await db.prepare("UPDATE invite_codes SET expires_at=unixepoch()").run();
    await denied(signup(), 403, "forbidden");
    expect(await db.prepare("SELECT SUM(used) FROM invite_codes").first("SUM(used)")).toBe(0);
  });
  it("enforces source/day, invite uses and the estimated D1 write budget transactionally", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => signup()));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 429]);
    await db
      .prepare("INSERT INTO rate_hits(bucket,subject,window_start,count) VALUES('estimated_writes','all',?,?)" +
        " ON CONFLICT(bucket,subject,window_start) DO UPDATE SET count=excluded.count")
      .bind(dayStart(), SPACE_LIMITS.signup_stop_writes - 1)
      .run();
    await denied(signup(), 429, "quota");
    await db.prepare("DELETE FROM spaces").run();
    await db.prepare("DELETE FROM rate_hits").run();
    await db.prepare("UPDATE invite_codes SET max_uses=used+1").run();
    expect((await Promise.all([signup(), signup()])).map((r) => r.status).sort()).toEqual([200, 403]);
  });
  it("rotates and recovers once, stores hashes and never emits application logs", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((k) => vi.spyOn(console, k));
    const s = await ok(signup());
    expect(s.key.startsWith("ams_")).toBe(true);
    expect(new Set(s.recovery_codes).size).toBe(10);
    const r = await room(s.key);
    const p = await member(r.room_id, s.key);
    const rotated = await ok(call("/api/me/rotate", "POST", s.key));
    await denied(call("/api/me", "GET", s.key), 403, "forbidden");
    const attempts = await Promise.all([recover(s.recovery_codes[0]), recover(s.recovery_codes[0])]);
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 403]);
    const recovered = await attempts.find((r) => r.ok)!.json<Reply>();
    await denied(call("/api/me", "GET", rotated.key), 403, "forbidden");
    await ok(call("/api/me", "GET", recovered.key));
    const tables = ["spaces", "participants", "invite_codes", "recovery_codes", "messages", "rate_hits"];
    const contents = JSON.stringify(await db.batch(tables.map((t) => db.prepare("SELECT * FROM " + t))));
    for (const secret of [s.key, rotated.key, recovered.key, p.key, invite, ...s.recovery_codes])
      expect(contents.includes(secret)).toBe(false);
    for (const spy of spies) expect(spy.mock.calls.length).toBe(0);
  });
  it("accepts only one concurrent rotation and denies suspended space and participant access", async () => {
    const s = await ok(signup());
    const r = await room(s.key);
    const p = await member(r.room_id, s.key);
    const responses = await Promise.all([call("/api/me/rotate", "POST", s.key), call("/api/me/rotate", "POST", s.key)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
    const rotated = await responses.find((response) => response.ok)!.json<Reply>();
    await db.prepare("UPDATE spaces SET status='suspended' WHERE id=?").bind(s.space_id).run();
    await denied(call("/api/me", "GET", rotated.key), 403, "forbidden");
    await denied(call("/api/rooms/" + r.room_id + "/messages", "GET", p.key), 403, "forbidden");
    expect((await call("/r/" + r.room_id + "/read", "GET", p.key)).status).toBe(403);
    await denied(recover(s.recovery_codes[1]), 403, "forbidden");
  });
  it("replaces recovery codes for the owning space and stores only hashes", async () => {
    const a = await ok(signup());
    const b = await ok(signup());
    const r = await room(a.key);
    const p = await member(r.room_id, a.key);
    const path = "/api/me/recovery-codes";
    await denied(call(path, "POST", p.key), 403, "forbidden");
    const { recovery_codes: codes } = await ok(call(path, "POST", a.key));
    expect(new Set(codes).size).toBe(10);
    const rows = await db.prepare("SELECT code_hash FROM recovery_codes WHERE space_id=?").bind(a.space_id)
      .all<{ code_hash: string }>();
    expect(new Set(rows.results.map((row) => row.code_hash))).toEqual(new Set(await Promise.all(codes.map(sha256hex))));
    await denied(recover(a.recovery_codes[0]), 403, "forbidden");
    await ok(recover(b.recovery_codes[0]));
    await ok(recover(codes[0]));
    await denied(recover(codes[0]), 403, "forbidden");
  });
  it("only lets the room owner rename room participants, including their own seat, without changing keys", async () => {
    const a = await ok(signup());
    const b = await ok(signup());
    const r = await room(a.key);
    const p = await member(r.room_id, a.key);
    const path = "/api/rooms/" + r.room_id;
    const target = path + "/participants/";
    await denied(call(target + p.participant_id, "PATCH", b.key, { name: "다른 이름" }), 404, "not_found");
    await denied(call(target + r.owner_participant_id, "PATCH", p.key, { name: "새 주인" }), 403, "forbidden");
    await ok(call(target + r.owner_participant_id, "PATCH", a.key, { name: "새 주인" }));
    await ok(call(target + p.participant_id, "PATCH", a.key, { name: "새 이름" }));
    const message = await ok(call(path + "/messages", "POST", p.key, { text: "이름 바꾼 뒤 메시지" }));
    expect(message.id).toBeGreaterThan(0);
    expect((await ok(call(path + "/participants", "GET", a.key))).participants.find(
      (row) => row.participant_id === p.participant_id,
    )?.name).toBe("새 이름");
    expect((await ok(call(path + "/participants", "GET", a.key))).participants.find(
      (row) => row.participant_id === r.owner_participant_id,
    )?.name).toBe("새 주인");
  });
  it("rejects credential mixups, cross-space operations and stale generations", async () => {
    const a = await ok(signup()),
      b = await ok(signup());
    const r = await room(a.key);
    const path = "/api/rooms/" + r.room_id;
    const p = await member(r.room_id, a.key);
    await denied(call("/api/me"), 401, "unauthorized");
    await denied(call("/api/me?k=invalid", "GET", a.key), 400, "invalid");
    for (const [suffix, method, body] of [
      ["", "PATCH", { name: "다른 방" }],
      ["", "DELETE", {}],
      ["/participants", "GET", undefined],
      ["/participants", "POST", { name: "새 사람", kind: "human" }],
      [`/participants/${p.participant_id}/reissue`, "POST", {}],
      [`/participants/${p.participant_id}/revoke`, "POST", {}],
      ["/messages", "GET", undefined],
      ["/messages", "POST", { text: "안녕" }],
    ] as const)
      await denied(call(path + suffix, method, b.key, body), 404, "not_found");
    await denied(call("/api/rooms", "GET", p.key), 403, "forbidden");
    await denied(call("/api/me", "GET", a.key, undefined, { ...local, KEY_EPOCH: "1" }), 403, "forbidden");
    await denied(
      call(
        "/api/spaces/recover",
        "POST",
        undefined,
        { code: a.recovery_codes[0], turnstile: testToken },
        { ...local, KEY_EPOCH: "1" },
      ),
      403,
      "forbidden",
    );
  });
});

describe("rooms, participants and messages", () => {
  it("lists and renames rooms, labels relays, tracks unread counts, returns single-use join instructions", async () => {
    const s = await ok(signup()),
      r = await room(s.key);
    const path = "/api/rooms/" + r.room_id;
    await ok(call(path, "PATCH", s.key, { name: "새 이름" }));
    const a = await member(r.room_id, s.key),
      h = await member(r.room_id, s.key, "사람", "human");
    const g = await member(r.room_id, s.key, "피클", "assistant", "get");
    expect(a.connection_text.includes("?k=")).toBe(false);
    expect(g.connection_text.includes("?k=")).toBe(true);
    const list = await ok(call(path + "/participants", "GET", s.key));
    expect(list.participants.filter((p) => p.is_owner)).toHaveLength(1);
    expect(list.participants.find((p) => p.participant_id === a.participant_id)?.status).toBe("created");
    expect(JSON.stringify(list).includes(a.key)).toBe(false);
    await denied(
      call(path + "/messages", "POST", h.key, { text: "거절", relayed_for: a.participant_id }),
      403,
      "forbidden",
    );
    await denied(
      call(path + "/messages", "POST", s.key, { text: "거절", relayed_for: "unknown-participant" }),
      404,
      "not_found",
    );
    await denied(call(path + "/messages", "POST", s.key, { text: "거절", reply_to: 99999 }), 400, "invalid");
    await ok(call(path + "/messages", "POST", h.key, { text: "안녕하세요" }));
    const rooms = await ok(call("/api/rooms", "GET", s.key));
    expect(rooms.rooms[0]).toMatchObject({ room_id: r.room_id, last_message: "안녕하세요", unread_count: 1 });
    await ok(call(path + "/messages", "POST", s.key, { text: "비서 답변", relayed_for: a.participant_id }));
    const read = await ok(call(path + "/messages?since=0", "GET", s.key));
    expect(read.messages[1]).toMatchObject({
      text: "비서 답변",
      relayed_for: a.participant_id,
      relay_label: "사용자가 대신 올림",
    });
    expect((await ok(call("/api/rooms", "GET", s.key))).rooms[0].unread_count).toBe(0);
    expect(await (await call(`/r/${r.room_id}/read`, "GET", a.key)).text()).toContain("[사용자가 대신 올림]");
    const again = await call(path + "/messages", "GET", a.key);
    expect(again.status).toBe(429);
    const wait = Number(again.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(30);
    expect((await again.json<Reply>()).retry_after).toBe(wait);
    expect(
      (await ok(call(path + "/participants", "GET", s.key))).participants.find(
        (p) => p.participant_id === a.participant_id,
      )?.status,
    ).toBe("connected");
    await db.prepare("UPDATE participants SET last_read_at=unixepoch()-301,read_guard_at=unixepoch()-301 WHERE id=?").bind(a.participant_id).run();
    expect(
      (await ok(call(path + "/participants", "GET", s.key))).participants.find(
        (p) => p.participant_id === a.participant_id,
      )?.status,
    ).toBe("last_seen");
    await ok(call(path + "/messages", "GET", a.key));
    await ok(call(path + "/messages", "GET", h.key));
    await ok(call(path + "/messages", "GET", h.key));
    expect((await ok(call("/api/me", "GET", s.key))).usage.messages_today).toBe(2);
    await ok(call(path, "DELETE", s.key));
    await denied(call(path + "/messages", "GET", a.key), 403, "forbidden");
  });
  it("reads a fresh human post immediately with the same assistant key and throttles empty or stale reads after first grace", async () => {
    const s = await ok(signup());
    const aRoom = await room(s.key);
    const bRoom = await ok(call("/api/rooms", "POST", s.key, { name: "다른 방" }));
    const a = await member(aRoom.room_id, s.key);
    const path = `/api/rooms/${aRoom.room_id}/messages`;
    const plainPath = `/r/${aRoom.room_id}/read`;
    expect((await (await call(plainPath, "GET", a.key)).text()).includes("# 새 글: 0개")).toBe(true);

    await ok(call(`/api/rooms/${bRoom.room_id}/messages`, "POST", s.key, { text: "다른 방의 새 글" }));
    await denied(call(`/api/rooms/${bRoom.room_id}/messages`, "GET", a.key), 403, "forbidden");
    await ok(call(path, "POST", a.key, { text: "비서가 쓴 글" }));
    await ok(call(path, "POST", s.key, { text: "방장이 옮긴 답", relayed_for: a.participant_id }));
    // Immediate next check succeeds once via first-empty-read grace, then arms the 30s cooldown.
    const secondGrace = await ok(call(path, "GET", a.key));
    expect(secondGrace.messages.map((m) => m.text)).toEqual(["비서가 쓴 글", "방장이 옮긴 답"]);
    await denied(call(path, "GET", a.key), 429, "rate_limited");
    const first = await ok(call(path, "POST", s.key, { text: "방장이 직접 쓴 새 글" }));
    const attempts = await Promise.all([call(path, "GET", a.key), call(plainPath, "GET", a.key)]);
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 429]);
    expect((await attempts.find((r) => r.ok)!.text()).includes("방장이 직접 쓴 새 글")).toBe(true);
    await denied(call(`${path}?since=0`, "GET", a.key), 429, "rate_limited");

    const second = await ok(call(path, "POST", s.key, { text: "방장이 쓴 다음 글" }));
    await denied(call(`${path}?since=${second.id}`, "GET", a.key), 429, "rate_limited");
    const next = await ok(call(`${path}?since=${first.id}`, "GET", a.key));
    expect(next.messages.map((m) => m.text)).toEqual(["방장이 쓴 다음 글"]);
    await db.prepare("UPDATE participants SET last_read_at=unixepoch()-12,read_guard_at=unixepoch()-12 WHERE id=?").bind(a.participant_id).run();
    const empty = await call(plainPath, "GET", a.key);
    expect(empty.status).toBe(429);
    const wait = Number(empty.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(15);
    expect(wait).toBeLessThanOrEqual(18);
    expect(await empty.json<Reply>()).toMatchObject({ error: "rate_limited", retry_after: wait });
    const count = await db.prepare("SELECT read_count AS total FROM participants WHERE id=?")
      .bind(a.participant_id).first("total");
    expect(count).toBe(4);
    await db.prepare("UPDATE participants SET last_read_at=unixepoch()-31,read_guard_at=unixepoch()-31 WHERE id=?").bind(a.participant_id).run();
    expect((await (await call(plainPath, "GET", a.key)).text()).includes("# 새 글: 0개")).toBe(true);
    await denied(call(path, "GET", a.key), 429, "rate_limited");
    expect(a.connection_text.includes("사용자가 직접 확인을 요청하면")).toBe(true);
    expect(a.connection_text.includes("평소 최소 30초마다")).toBe(true);
    expect(a.connection_text.includes("5분 이상의 간격을 권장")).toBe(true);
    expect(a.connection_text.includes("Retry-After")).toBe(true);
  });

  it("allows one immediate follow-up after first empty read and blocks reconnect, since or concurrent abuse", async () => {
    const s = await ok(signup());
    const r = await room(s.key);
    const otherRoom = await ok(call("/api/rooms", "POST", s.key, { name: "격리 방" }));
    const a = await member(r.room_id, s.key, "비서A", "assistant", "header");
    const b = await member(r.room_id, s.key, "비서B", "assistant", "get");
    const c = await member(otherRoom.room_id, s.key, "비서C", "assistant", "header");
    const apiPath = `/api/rooms/${r.room_id}/messages`;
    const plainPath = `/r/${r.room_id}/read`;

    // 1st empty -> immediate 2nd empty (across read paths) -> 3rd blocked with 429 Retry-After (1..30s).
    expect((await ok(call(apiPath, "GET", a.key))).messages).toEqual([]);
    expect((await (await call(plainPath, "GET", a.key)).text()).includes("# 새 글: 0개")).toBe(true);
    const third = await call(apiPath, "GET", a.key);
    expect(third.status).toBe(429);
    const wait = Number(third.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(30);
    expect(await third.json<Reply>()).toMatchObject({ error: "rate_limited", retry_after: wait });

    // Manipulating since or alternating read endpoints does not re-trigger the first-empty-read grace.
    await denied(call(`${apiPath}?since=0`, "GET", a.key), 429, "rate_limited");
    await denied(call(`${plainPath}?since=999999`, "GET", a.key), 429, "rate_limited");
    // Room and key isolation: another assistant in the same room and another room's assistant keep their own first empty read.
    expect((await ok(call(apiPath, "GET", b.key))).messages).toEqual([]);
    expect((await ok(call(`/api/rooms/${otherRoom.room_id}/messages`, "GET", c.key))).messages).toEqual([]);

    // 1st empty -> fresh human post arrives immediately -> read succeeds and arms cooldown so immediate empty repeat fails.
    const postAfterEmpty = await ok(call(apiPath, "POST", s.key, { text: "첫 빈 뒤 바로 새 글" }));
    const freshAfterEmpty = await ok(call(apiPath, "GET", b.key));
    expect(freshAfterEmpty.messages.map((m) => m.text)).toEqual(["첫 빈 뒤 바로 새 글"]);
    await denied(call(plainPath, "GET", b.key), 429, "rate_limited");

    // Non-empty first read on a new key arms cooldown immediately (no extra empty repeat allowed).
    const late = await member(r.room_id, s.key, "비서Late", "assistant", "header");
    const firstNonEmpty = await ok(call(apiPath, "GET", late.key));
    expect(firstNonEmpty.messages.map((m) => m.text)).toEqual(["첫 빈 뒤 바로 새 글"]);
    await denied(call(`${apiPath}?since=${postAfterEmpty.id}`, "GET", late.key), 429, "rate_limited");

    // Concurrent first reads on an empty room consume at most 2 (1st empty + 1 grace), blocking the 3rd.
    const d = await member(otherRoom.room_id, s.key, "비서D", "assistant", "header");
    const otherApi = `/api/rooms/${otherRoom.room_id}/messages`;
    // Note otherRoom had no messages yet; send 3 concurrent reads for d while manipulating since=999 on one.
    const concurrent = await Promise.all([
      call(otherApi, "GET", d.key),
      call(`${otherApi}?since=999`, "GET", d.key),
      call(`/r/${otherRoom.room_id}/read`, "GET", d.key),
    ]);
    expect(concurrent.map((res) => res.status).sort()).toEqual([200, 200, 429]);

    // After 30s passes, re-check works on both read paths and re-arms cooldown.
    await db.prepare("UPDATE participants SET last_read_at=unixepoch()-31,read_guard_at=unixepoch()-31 WHERE id=?").bind(a.participant_id).run();
    expect((await ok(call(apiPath, "GET", a.key))).messages.map((m) => m.text)).toEqual(["첫 빈 뒤 바로 새 글"]);
    await denied(call(plainPath, "GET", a.key), 429, "rate_limited");
  });

  it("supports interval_minutes and expanded ai_types across create, list, patch, reissue and guides", async () => {
    const s = await ok(signup());
    const otherSpace = await ok(signup());
    const r = await room(s.key);
    const path = `/api/rooms/${r.room_id}`;
    const presets = [
      ["claude", 5],
      ["chatgpt", 10],
      ["gemini", 15],
      ["pickle", 30],
      ["vooy", 60],
      ["cue", 1],
      ["instinct", 17],
      ["keyring", 45],
      ["muse", 120],
    ] as const;
    // Test default 10 for omitted interval_minutes on other, and custom/preset intervals across new ai_types.
    const defaultOther = await ok(call(path + "/participants", "POST", s.key, { name: "기타", kind: "assistant" }));
    expect(defaultOther).toMatchObject({ ai_type: "other", interval_minutes: 10 });
    expect(defaultOther.connection_text).toContain("4) 확인 주기");
    expect(defaultOther.connection_text).toContain("설정된 10분 간격");
    expect(defaultOther.connection_text).toContain("실제 스케줄 실행을 보장하지 않으며");

    const created: Record<string, Reply> = { other: defaultOther };
    for (const [ai, mins] of presets.slice(0, 6)) {
      const p = await ok(
        call(path + "/participants", "POST", s.key, {
          name: `봇_${ai}`,
          kind: "assistant",
          ai_type: ai,
          delivery: "header",
          interval_minutes: mins,
        }),
      );
      expect(p).toMatchObject({ ai_type: ai, interval_minutes: mins });
      expect(p.connection_text).toContain(`설정된 ${mins}분 간격`);
      created[ai] = p;
    }

    // Even with interval_minutes=1, the 30s API repeat cooldown remains separate on both read paths.
    const secondRoom = await ok(call("/api/rooms", "POST", s.key, { name: "추가 방" }));
    for (const [ai, mins] of presets.slice(6)) {
      const p = await ok(
        call(`/api/rooms/${secondRoom.room_id}/participants`, "POST", s.key, {
          name: `봇_${ai}`,
          kind: "assistant",
          ai_type: ai,
          delivery: "header",
          interval_minutes: mins,
        }),
      );
      expect(p).toMatchObject({ ai_type: ai, interval_minutes: mins });
      expect(p.connection_text).toContain(`설정된 ${mins}분 간격`);
    }
    const cueKey = created.cue.key;
    expect((await ok(call(path + "/messages", "GET", cueKey))).messages).toEqual([]);
    expect((await (await call(`/r/${r.room_id}/read`, "GET", cueKey)).text()).includes("# 새 글: 0개")).toBe(true);
    await denied(call(path + "/messages", "GET", cueKey), 429, "rate_limited");
    await denied(call(`/r/${r.room_id}/read`, "GET", cueKey), 429, "rate_limited");

    // Create human participant (human cannot take assistant ai_type or interval_minutes).
    const secondPath = `/api/rooms/${secondRoom.room_id}`;
    const h = await member(secondRoom.room_id, s.key, "사람", "human");
    await denied(
      call(secondPath + "/participants", "POST", s.key, { name: "금지사람", kind: "human", interval_minutes: 15 }),
      400,
      "invalid",
    );
    await denied(
      call(secondPath + "/participants", "POST", s.key, { name: "금지AI", kind: "human", ai_type: "vooy" }),
      400,
      "invalid",
    );
    await denied(
      call(secondPath + "/participants", "POST", s.key, { name: "금지비서", kind: "assistant", ai_type: "human" }),
      400,
      "invalid",
    );
    for (const bad of [0, -1, 1.5, "10", null, SPACE_LIMITS.retention_days * 1440 + 1]) {
      await denied(
        call(secondPath + "/participants", "POST", s.key, { name: "잘못된주기", kind: "assistant", interval_minutes: bad }),
        400,
        "invalid",
      );
    }

    // Check GET participants returns interval_minutes (preserving selection, 10 default), first_read_at, last_read_at, last_seen_at.
    const roster = await ok(call(path + "/participants", "GET", s.key));
    const cueRow = roster.participants.find((p) => p.participant_id === created.cue.participant_id)!;
    expect(cueRow).toMatchObject({ ai_type: "cue", interval_minutes: 1, status: "connected" });
    expect(typeof cueRow.first_read_at).toBe("number");
    expect(cueRow.last_seen_at).toBe(cueRow.last_read_at);

    // PATCH interval_minutes only, name only, and both without rotating key or altering read timestamps.
    const target = `${path}/participants/${created.cue.participant_id}`;
    expect(await ok(call(target, "PATCH", s.key, { interval_minutes: 45 }))).toMatchObject({ interval_minutes: 45 });
    expect(await ok(call(target, "PATCH", s.key, { name: "큐2", interval_minutes: 30 }))).toMatchObject({
      name: "큐2",
      interval_minutes: 30,
    });
    await denied(call(target, "PATCH", s.key, {}), 400, "invalid");
    await denied(call(`${secondPath}/participants/${h.participant_id}`, "PATCH", s.key, { interval_minutes: 15 }), 400, "invalid");
    await denied(call(`${secondPath}/participants/${h.participant_id}/reissue`, "POST", otherSpace.key, { interval_minutes: 15 }), 404, "not_found");
    await denied(call(`${secondPath}/participants/${h.participant_id}/reissue`, "POST", s.key, { interval_minutes: 15 }), 400, "invalid");

    // Reissue preserves interval_minutes in guide and resets read timestamps + first-empty-read grace.
    const reissued = await ok(call(`${target}/reissue`, "POST", s.key));
    expect(reissued.interval_minutes).toBe(30);
    expect(reissued.connection_text).toContain("설정된 30분 간격");
    const afterReissue = (await ok(call(path + "/participants", "GET", s.key))).participants.find(
      (p) => p.participant_id === created.cue.participant_id,
    )!;
    expect(afterReissue).toMatchObject({
      name: "큐2",
      interval_minutes: 30,
      first_read_at: null,
      last_read_at: null,
      status: "created",
    });
    expect((await ok(call(path + "/messages", "GET", reissued.key))).messages).toEqual([]);
    expect((await ok(call(path + "/messages", "GET", reissued.key))).messages).toEqual([]);
    await denied(call(path + "/messages", "GET", reissued.key), 429, "rate_limited");
  });

  it("guides hark with manual 답 옮기기 only and keeps relayed replies distinct from direct assistant reads", async () => {
    const s = await ok(signup());
    const r = await room(s.key);
    const path = `/api/rooms/${r.room_id}`;
    const hark = await ok(
      call(path + "/participants", "POST", s.key, {
        name: "하크",
        kind: "assistant",
        ai_type: "hark",
        delivery: "get",
        interval_minutes: 15,
      }),
    );
    const watcher = await member(r.room_id, s.key, "피클", "assistant", "header");
    expect(hark.ai_type).toBe("hark");
    expect(hark.interval_minutes).toBe(15);
    expect(hark.connection_text).toContain("답 옮기기");
    expect(hark.connection_text).toContain("자동 읽기·쓰기를 지원하지 않습니다");
    expect(hark.connection_text).toContain("4) 확인 주기");
    expect(hark.connection_text).toContain("15분");
    expect(hark.connection_text).toContain("0) 먼저 지킬 것");
    // Must not generate external room URLs or URL-bypass instructions.
    expect(hark.connection_text).not.toMatch(/https?:\/\/|\?k=|\/read\b|\/send\b|\/messages\b/);

    // Watcher uses up its 1st empty read + 2nd grace check so 30s cooldown is armed.
    expect((await ok(call(path + "/messages", "GET", watcher.key))).messages).toEqual([]);
    expect((await ok(call(path + "/messages", "GET", watcher.key))).messages).toEqual([]);
    await denied(call(path + "/messages", "GET", watcher.key), 429, "rate_limited");

    // Owner relays Hark's reply into the room.
    const relayed = await ok(
      call(path + "/messages", "POST", s.key, {
        text: "사람이 하크에서 복사해 옮긴 답",
        relayed_for: hark.participant_id,
      }),
    );
    expect(relayed.id).toBeGreaterThan(0);

    // Real writer in messages is room owner, with relay_label and relayed_for pointing to hark.
    const roomRead = await ok(call(`${path}/messages?since=0`, "GET", s.key));
    expect(roomRead.messages[0]).toMatchObject({
      text: "사람이 하크에서 복사해 옮긴 답",
      participant_id: r.owner_participant_id,
      relayed_for: hark.participant_id,
      relay_label: "사용자가 대신 올림",
    });

    // Hark's own direct-read timestamps remain null (status: created), and the relayed post does NOT bypass watcher's 30s cooldown.
    const harkRow = (await ok(call(path + "/participants", "GET", s.key))).participants.find(
      (p) => p.participant_id === hark.participant_id,
    )!;
    expect(harkRow).toMatchObject({
      first_read_at: null,
      last_read_at: null,
      last_seen_at: null,
      status: "created",
    });
    await denied(call(path + "/messages", "GET", watcher.key), 429, "rate_limited");
  });

  it("preserves pre-0006 null-interval rows, never-checked timestamps, and legacy keys", async () => {
    const s = await ok(signup());
    const r = await room(s.key);
    const path = `/api/rooms/${r.room_id}`;
    const legacyFresh = await member(r.room_id, s.key, "기존미확인", "assistant", "header");
    const legacySeen = await member(r.room_id, s.key, "기존확인됨", "assistant", "header");
    await db
      .prepare("UPDATE participants SET interval_minutes=NULL,first_read_at=NULL,last_read_at=NULL,cooldown_armed=0 WHERE id=?")
      .bind(legacyFresh.participant_id)
      .run();
    await db
      .prepare("UPDATE participants SET interval_minutes=NULL,first_read_at=unixepoch()-10,last_read_at=unixepoch()-5,cooldown_armed=1 WHERE id=?")
      .bind(legacySeen.participant_id)
      .run();

    const roster = (await ok(call(path + "/participants", "GET", s.key))).participants;
    expect(roster.find((p) => p.participant_id === legacyFresh.participant_id)).toMatchObject({
      interval_minutes: 10,
      first_read_at: null,
      last_read_at: null,
      last_seen_at: null,
      status: "created",
    });
    expect(roster.find((p) => p.participant_id === legacySeen.participant_id)).toMatchObject({
      interval_minutes: 10,
      status: "connected",
    });
    await denied(call(path + "/messages", "GET", legacySeen.key), 429, "rate_limited");
    expect((await ok(call(path + "/messages", "GET", legacyFresh.key))).messages).toEqual([]);
    expect((await ok(call(path + "/messages", "GET", legacyFresh.key))).messages).toEqual([]);
    await denied(call(path + "/messages", "GET", legacyFresh.key), 429, "rate_limited");
  });

  it("keeps the existing per-minute ceiling even when there is fresh human text", async () => {
    const s = await ok(signup());
    const r = await room(s.key);
    const a = await member(r.room_id, s.key);
    const path = `/api/rooms/${r.room_id}/messages`;
    await ok(call(path, "GET", a.key));
    await ok(call(path, "POST", s.key, { text: "아직 읽지 않은 글" }));
    await db.prepare("UPDATE participants SET read_count=20,read_minute=unixepoch()/60*60 WHERE id=?")
      .bind(a.participant_id).run();
    const capped = await call(path, "GET", a.key);
    expect(capped.status).toBe(429);
    const wait = Number(capped.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
    expect(await capped.json<Reply>()).toMatchObject({ error: "rate_limited", retry_after: wait });
    await db.prepare("UPDATE participants SET read_count=0 WHERE id=?").bind(a.participant_id).run();
    expect((await ok(call(path, "GET", a.key))).messages.map((m) => m.text)).toEqual(["아직 읽지 않은 글"]);
  });

  it("enforces room, member, body and whole-space post limits across both protocols", async () => {
    const s = await ok(signup()),
      r = await room(s.key);
    const path = "/api/rooms/" + r.room_id;
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () => call("/api/rooms", "POST", s.key, { name: "방" })),
    );
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 429]);
    const p = await member(r.room_id, s.key);
    const more = await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        call(path + "/participants", "POST", s.key, { name: "사람" + i, kind: "human" }),
      ),
    );
    expect(more.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 429]);
    await denied(call(path + "/messages", "POST", s.key, { text: "a".repeat(2001) }), 400, "invalid");
    await denied(call(path + "/messages", "POST", s.key, { text: "한".repeat(1366) }), 400, "invalid");
    await ok(call(path + "/messages", "POST", s.key, { text: "한".repeat(1048) + "a".repeat(952) }));
    await db
      .prepare("UPDATE rate_hits SET count=499 WHERE bucket='space_posts' AND subject=? AND window_start=?")
      .bind(s.space_id, dayStart())
      .run();
    const posts = await Promise.all([
      call(path + "/messages", "POST", s.key, { text: "마지막" }),
      call("/r/" + r.room_id + "/send", "POST", p.key, { text: "경계" }),
    ]);
    expect(posts.map((r) => r.status).sort()).toEqual([200, 429]);
    await denied(call(path + "/messages", "POST", s.key, { text: "한도" }), 429, "quota");
    expect((await ok(call("/api/me", "GET", s.key))).usage.messages_today).toBe(500);
  });
  it("revokes, reissues and deletes immediately, then sweeps only after 24 hours", async () => {
    const s = await ok(signup()),
      r = await room(s.key),
      p = await member(r.room_id, s.key);
    const path = "/api/rooms/" + r.room_id;
    const target = path + "/participants/" + p.participant_id;
    await ok(call(target + "/revoke", "POST", s.key));
    await denied(call(path + "/messages", "GET", p.key), 403, "forbidden");
    const next = await ok(call(target + "/reissue", "POST", s.key));
    await denied(call(path + "/messages", "GET", p.key), 403, "forbidden");
    await ok(call(path + "/messages", "GET", next.key));
    await denied(call(path + "/participants/" + r.owner_participant_id + "/reissue", "POST", s.key), 404, "not_found");
    await denied(call("/api/me", "DELETE", s.key, { confirm: "no" }), 400, "invalid");
    await ok(call("/api/me", "DELETE", s.key, { confirm: "삭제" }));
    await denied(call("/api/me", "GET", s.key), 403, "forbidden");
    await denied(call(path + "/messages", "GET", next.key), 403, "forbidden");
    await denied(recover(s.recovery_codes[0]), 403, "forbidden");
    await purge(local);
    expect(await db.prepare("SELECT status FROM spaces WHERE id=?").bind(s.space_id).first("status")).toBe("deleted");
    await db.prepare("UPDATE spaces SET deleted_at=unixepoch()-86400 WHERE id=?").bind(s.space_id).run();
    await purge(local);
    expect(await db.prepare("SELECT 1 FROM rooms WHERE id=?").bind(r.room_id).first()).toBeNull();
  });
  it("preserves legacy room, participant, message ids and credentials across owner migration", async () => {
    const headers = { authorization: "Bearer " + env.TEST_OWNER_KEY, "content-type": "application/json" };
    const admin = (path: string, body: unknown) =>
      worker.fetch(
        new Request("http://127.0.0.1" + path, { method: "POST", headers, body: JSON.stringify(body) }),
        local,
      );
    const r = await ok(admin("/admin/rooms", { name: "기존 방" }));
    const p = await ok(admin("/admin/rooms/" + r.room_id + "/participants", { name: "공간 주인", kind: "assistant" }));
    const old = await ok(call("/r/" + r.room_id + "/send", "POST", p.key, { text: "보존할 글" }));
    const key = newKey("ams_"),
      id = "migrated";
    await migrateOwnerRows(
      db,
      "o_default",
      id,
      0,
      await sha256hex(key),
      await Promise.all(Array.from({ length: 10 }, () => sha256hex(newKey("amr_")))),
    );
    expect((await ok(call("/api/me", "GET", key))).usage.messages_today).toBe(1);
    const list = await ok(call("/api/rooms", "GET", key));
    expect(list.rooms.some((row) => row.room_id === r.room_id && row.last_message === "보존할 글")).toBe(true);
    const text = await (await call("/r/" + r.room_id + "/read", "GET", p.key)).text();
    expect(text.includes("[" + old.id + "]") && text.includes("보존할 글")).toBe(true);
    expect(
      (await ok(call("/api/rooms/" + r.room_id + "/participants", "GET", key))).participants.some(
        (row) => row.participant_id === p.participant_id,
      ),
    ).toBe(true);
    const roster = (await ok(call("/api/rooms/" + r.room_id + "/participants", "GET", key))).participants;
    expect(roster.find((row) => row.participant_id === p.participant_id)).toMatchObject({
      name: "이전 참가자: 공간 주인",
      is_owner: false,
    });
    expect(roster.find((row) => row.is_owner)?.name).toBe("공간 주인");
    await denied(admin("/admin/rooms", { name: "이전 끝" }), 403, "forbidden");
  });
});

describe("security review repairs", () => {

  it("caps room-list history scans while distinguishing exact, saturated and partial unread counts", async () => {
    const s = await ok(signup()), outsider = await ok(signup());
    const r = await room(s.key), other = await room(outsider.key);
    const a = await member(r.room_id, s.key);
    const add = (room: string, author: string, count: number, ageDays = 0) => db.prepare(
      "WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n<?)" +
      " INSERT INTO messages(room_id,participant_id,body,body_hash,created_at)" +
      " SELECT ?,?,'합성 글','fixture-'||n,unixepoch()-?*86400 FROM sequence",
    ).bind(count, room, author, ageDays).run();
    const list = async (key: string) => {
      const response = await call("/api/rooms", "GET", key);
      expect(response.status).toBe(200);
      return (await response.json<{ rooms: object[] }>()).rooms;
    };
    await add(r.room_id, a.participant_id, 99);
    expect((await list(s.key))[0]).toMatchObject({ unread_count: 99, unread_partial: false, preview_partial: false });
    await add(r.room_id, a.participant_id, 2);
    expect((await list(s.key))[0]).toMatchObject({ unread_count: 100, unread_partial: false });
    const ownerSeat = await db.prepare("SELECT id FROM participants WHERE room_id=? AND is_owner=1")
      .bind(r.room_id).first<string>("id");
    await add(r.room_id, ownerSeat!, 300);
    expect((await list(s.key))[0]).toMatchObject({ unread_count: 0, unread_partial: true, last_message: "합성 글" });
    await db.prepare("UPDATE participants SET last_read_id=(SELECT max(id) FROM messages WHERE room_id=?) WHERE id=?")
      .bind(r.room_id, ownerSeat).run();
    expect((await list(s.key))[0]).toMatchObject({ unread_count: 0, unread_partial: false, last_message: "합성 글" });

    const old = await member(other.room_id, outsider.key);
    await add(other.room_id, old.participant_id, 1);
    await add(other.room_id, old.participant_id, 300, 40);
    const rooms = await list(outsider.key);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ room_id: other.room_id, unread_count: 0, unread_partial: true, preview_partial: true, last_message: null });

    const points = DEFAULT_SPACE_DAILY_WRITE_LIMIT - 3;
    await db.prepare("UPDATE spaces SET request_day=?,request_count=2,request_write_estimate=? WHERE id=?")
      .bind(dayStart(), points, s.space_id).run();
    const capped = await call("/api/rooms", "GET", s.key);
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({ error: "quota", scope: "space_day" });
    expect(await db.prepare("SELECT request_count,request_write_estimate FROM spaces WHERE id=?").bind(s.space_id).first())
      .toEqual({ request_count: 2, request_write_estimate: points });
    expect(await list(outsider.key)).toHaveLength(1);
    await db.prepare("UPDATE messages SET created_at=unixepoch()-40*86400 WHERE room_id=?").bind(other.room_id).run();
    expect((await list(outsider.key))[0]).toMatchObject({ unread_count: 0, unread_partial: false, preview_partial: false });
  });


  it("charges a space atomically without blocking another space and resets at midnight UTC", async () => {
    const a = await ok(signup()), b = await ok(signup());
    const confined = await room(a.key);
    const memberA = await member(confined.room_id, a.key);
    const today = dayStart();
    vi.spyOn(Date, "now").mockReturnValue((today + 64_801) * 1000);
    await db.prepare("UPDATE spaces SET request_day=?,request_write_estimate=? WHERE id=?")
      .bind(today, DEFAULT_SPACE_DAILY_WRITE_LIMIT - 64, a.space_id).run();
    const patch = () => call("/api/me", "PATCH", a.key, { room_limit: 5 });
    const concurrent = await Promise.all([patch(), patch()]);
    expect(concurrent.map(r => r.status).sort()).toEqual([200, 429]);
    const rejected = concurrent.find(r => r.status === 429)!;
    expect(Number(rejected.headers.get("retry-after"))).toBe(86_400 - 64_801);
    expect(await rejected.json()).toMatchObject({ error: "quota", scope: "space_day" });
    expect(await db.prepare("SELECT request_write_estimate FROM spaces WHERE id=?").bind(a.space_id)
      .first("request_write_estimate")).toBe(DEFAULT_SPACE_DAILY_WRITE_LIMIT);
    const text = await call("/r/" + confined.room_id + "/read", "GET", memberA.key);
    expect(text.status).toBe(429);
    expect(await text.text()).toMatch(/^error: quota\n이 공간의 .*UTC 자정/m);
    await room(b.key);
    const plan = await db.prepare("EXPLAIN QUERY PLAN SELECT SUM(request_write_estimate) FROM spaces WHERE request_day=?")
      .bind(today).all<{ detail: string }>();
    expect(plan.results.map(r => r.detail).join(" ")).toMatch(/USING INDEX spaces_request_day/);
    vi.spyOn(Date, "now").mockReturnValue((today + 86_401) * 1000);
    await ok(patch());
    expect(await db.prepare("SELECT request_write_estimate FROM spaces WHERE id=?").bind(a.space_id)
      .first("request_write_estimate")).toBe(66);
  });

  it("closes an oversized room inside the configured space allocation and still refuses a depleted space", async () => {
    const s = await ok(signup());
    const r = await room(s.key);
    const tuned = { ...local, SPACE_DAILY_WRITE_LIMIT: "1000" };
    await db.prepare(
      "WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n<8000)" +
      " INSERT INTO messages(room_id,participant_id,body,body_hash,created_at)" +
      " SELECT room_id,id,'synthetic','fixture-'||n,unixepoch() FROM participants CROSS JOIN sequence" +
      " WHERE room_id=? AND is_owner=1",
    ).bind(r.room_id).run();
    const deleting = await call("/api/rooms/" + r.room_id, "DELETE", s.key, undefined, tuned);
    expect(deleting.status).toBe(200);
    expect(await deleting.json()).toMatchObject({ deleted: true, cleanup_pending: true });
    expect(await db.prepare("SELECT count(*) AS n FROM messages WHERE room_id=?").bind(r.room_id).first("n")).toBe(8000);
    await db.prepare("UPDATE spaces SET request_day=?,request_write_estimate=1000 WHERE id=?")
      .bind(dayStart(),s.space_id).run();
    const rejected = await call("/api/me", "GET", s.key, undefined, tuned);
    expect(rejected.status).toBe(429);
    expect(rejected.headers.has("retry-after")).toBe(true);
    expect(await rejected.json()).toMatchObject({ error: "quota", scope: "space_day" });
    // This synthetic room is queued for cleanup. Later policy tests use their own retention fixtures.
    await db.prepare("DELETE FROM rooms WHERE id=?").bind(r.room_id).run();
  });


  it("keeps an exhausted space recoverable and preserves the last reserve for recovery codes", async () => {
    const s = await ok(signup()), other = await ok(signup());
    const r = await room(s.key);
    const a = await member(r.room_id, s.key);
    const b = await member(r.room_id, s.key, "둘째 비서");
    const now = Math.floor(Date.now() / 60_000) * 60 + 5;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const setSpace = (points: number, requests: number) => db.prepare(
      "UPDATE spaces SET request_day=?,request_write_estimate=?,request_count=? WHERE id=?",
    ).bind(dayStart(), points, requests, s.space_id).run();
    await setSpace(DEFAULT_SPACE_DAILY_WRITE_LIMIT, LIMITS.space_day[0]);
    await denied(call("/api/me", "GET", s.key), 429, "rate_limited");
    await room(other.key);
    const one = "/api/rooms/" + r.room_id + "/participants/" + a.participant_id + "/revoke";
    const all = "/api/me/participants/revoke-all";
    await ok(call(one, "POST", s.key));
    expect((await ok(call(all, "POST", s.key))).revoked_count).toBe(1);
    for (const seat of [a, b]) await denied(call("/r/" + r.room_id + "/messages", "GET", seat.key), 403, "forbidden");
    const restored = await ok(recover(s.recovery_codes[0]));
    const state = await db.prepare("SELECT request_write_estimate,request_count FROM spaces WHERE id=?")
      .bind(s.space_id).first();
    expect(state).toEqual({
      request_write_estimate: DEFAULT_SPACE_DAILY_WRITE_LIMIT + 64 + (32 + 3 * 2 + 2 * 12) + 96,
      request_count: LIMITS.space_day[0] + 3,
    });
    await setSpace(DEFAULT_SPACE_DAILY_WRITE_LIMIT + 5900, LIMITS.space_day[0] + 95);
    expect((await call(all, "POST", restored.key)).status).toBe(429);
    await ok(recover(s.recovery_codes[1]));
    await setSpace(DEFAULT_SPACE_DAILY_WRITE_LIMIT + 5900, LIMITS.space_day[0] + 100);
    const rejected = await recover(s.recovery_codes[2]);
    const wait = 86400 - now % 86400;
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("retry-after")).toBe(String(wait));
    expect(await rejected.json()).toMatchObject({ error: "rate_limited", retry_after: wait });
  });

  it("clamps numeric space limits and reports the effective cap through authenticated usage", async () => {
    const s = await ok(signup());
    for (const [value, expected] of [["500", 1000], ["-1", 1000], [" 25500 ", 25500], ["40000", 30000], ["20,000", 24000]] as const) {
      const response = await call("/api/me", "GET", s.key, undefined, { ...local, SPACE_DAILY_WRITE_LIMIT: value });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ limits: { space_daily_write_limit: expected, space_requests_per_day: 10000 } });
    }
  });

  it("keeps 24 hours of cleanup for one deleted space below the service writing cutoff", async () => {
    const gone = await ok(signup()), other = await ok(signup());
    const deadRoom = await room(gone.key);
    for (let i = 0; i < 6; i++) await member(deadRoom.room_id, gone.key, "합성 참가자 " + i);
    await db.prepare(
      "WITH RECURSIVE q(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM q WHERE n<3000)" +
      " INSERT INTO messages(room_id,participant_id,body,body_hash,created_at)" +
      " SELECT room_id,id,'x','h'||n,unixepoch()-5*86400 FROM participants CROSS JOIN q WHERE room_id=? AND is_owner=1",
    ).bind(deadRoom.room_id).run();
    const day = dayStart();
    await db.batch([
      db.prepare("UPDATE spaces SET status='deleted',deleted_at=? WHERE id=?").bind(day - 3 * 86400, gone.space_id),
      db.prepare("DELETE FROM rate_hits"),
      db.prepare("UPDATE spaces SET request_day=?,request_write_estimate=CASE WHEN id=? THEN 20000 ELSE 0 END,request_count=1")
        .bind(day, other.space_id),
    ]);
    const clock = vi.spyOn(Date,"now");
    for (let hour = 1; hour <= 24; hour++) {
      clock.mockReturnValue((day + hour * 3600 - 2400) * 1000);
      await purge(local);
      expect(await readWriteEstimate(db)).toBeLessThanOrEqual(45_000);
    }
    expect(await readWriteEstimate(db)).toBeGreaterThan(20_000);
    expect(await db.prepare("SELECT count(*) AS n FROM messages WHERE room_id=?").bind(deadRoom.room_id).first<number>("n"))
      .toBeGreaterThan(0);
    clock.mockReturnValue((day + 86000) * 1000);
    await room(other.key);
    expect(await readWriteEstimate(db)).toBeLessThan(STOP_MUTATIONS);
  });

  it("counts bad address confirmations against the existing send and space counters", async () => {
    const s = await ok(signup());
    const r = await room(s.key);
    const a = await member(r.room_id, s.key);
    vi.spyOn(Date, "now").mockReturnValue(Math.floor(Date.now() / 60_000) * 60_000 + 5_000);
    const path = "/r/" + r.room_id + "/send?" + new URLSearchParams({
      k: a.key, c: "amt_v2_0_" + "A".repeat(43), text: "합성 글",
    });
    const attempts = await Promise.all(Array.from({ length: 7 }, () => call(path)));
    expect(attempts.map(r => r.status).sort()).toEqual([409, 409, 409, 409, 409, 409, 429]);
    const tally = await db.prepare("SELECT bucket,count FROM rate_hits WHERE subject=? ORDER BY bucket")
      .bind(a.participant_id).all();
    expect(tally.results).toEqual([{ bucket: "send", count: 6 }, { bucket: "send_day", count: 6 }]);
    expect(await db.prepare("SELECT count(*) AS n FROM messages WHERE room_id=?").bind(r.room_id).first("n")).toBe(0);
    const spaceCount = await db.prepare("SELECT request_count FROM spaces WHERE id=?").bind(s.space_id).first("request_count");
    expect(spaceCount).toBe(8);
  });

  it("gives bulk request retries and leaves already revoked seats untouched on space deletion", async () => {
    const s = await ok(signup());
    const r = await room(s.key);
    const active = await member(r.room_id, s.key, "활성 비서");
    const old = await member(r.room_id, s.key, "폐기 비서");
    await db.prepare("UPDATE participants SET revoked=1 WHERE id=?").bind(old.participant_id).run();
    await db.prepare("CREATE TRIGGER watch_revoked BEFORE UPDATE OF revoked ON participants WHEN OLD.revoked=1 BEGIN " +
      "SELECT RAISE(ABORT,'already revoked'); END").run();
    const now = Math.floor(Date.now() / 60_000) * 60 + 5;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const del = () => call("/api/me", "DELETE", s.key, { confirm: "삭제" });
    await db.prepare("UPDATE spaces SET request_day=?,request_count=? WHERE id=?").bind(dayStart(), LIMITS.space_day[0], s.space_id).run();
    const daily = await del();
    expect(daily.status).toBe(429);
    expect(daily.headers.get("retry-after")).toBe(String(86400 - now % 86400));
    expect(await daily.json()).toMatchObject({ error: "rate_limited", retry_after: 86400 - now % 86400 });
    await db.prepare("UPDATE spaces SET request_count=2,request_minute=?,request_minute_count=60 WHERE id=?")
      .bind(now - now % 60, s.space_id).run();
    const minute = await call("/api/rooms/" + r.room_id, "DELETE", s.key);
    expect(minute.headers.get("retry-after")).toBe("55");
    expect(await minute.json()).toMatchObject({ error: "rate_limited", retry_after: 55 });
    const revoke = await call("/api/me/participants/revoke-all", "POST", s.key);
    expect(revoke.headers.get("retry-after")).toBe("55");
    expect(await revoke.json()).toMatchObject({ error: "rate_limited", retry_after: 55 });
    await db.prepare("UPDATE spaces SET request_minute_count=0 WHERE id=?").bind(s.space_id).run();
    expect((await del()).status).toBe(200);
    expect(await db.prepare("SELECT revoked FROM participants WHERE id=?").bind(active.participant_id).first("revoked")).toBe(1);
    expect(await db.prepare("SELECT status FROM spaces WHERE id=?").bind(s.space_id).first("status")).toBe("deleted");
  });

  it("limits a source's daily auth-failure reserve without locking valid credentials all day", async () => {
    const s = await ok(signup());
    const r = await room(s.key);
    const a = await member(r.room_id, s.key);
    const path = "/r/" + r.room_id + "/messages";
    const source = await sourceOf(new Request("http://127.0.0.1" + path), local);
    const day = dayStart();
    await db.prepare("INSERT INTO rate_hits(bucket,subject,window_start,count) VALUES('auth_fail_day',?,?,299)")
      .bind(source, day).run();
    const before = await db.prepare("SELECT count FROM rate_hits WHERE bucket='estimated_writes'").first<number>("count");
    await denied(call(path, "GET", newKey("amk_")), 403, "forbidden");
    await denied(call(path, "GET", newKey("amk_")), 429, "rate_limited");
    expect(await db.prepare("SELECT count FROM rate_hits WHERE bucket='estimated_writes'").first("count")).toBe(before! + 12);
    const rejected = await recover("invalid-fixture");
    expect(rejected.status).toBe(429);
    const delay = Number(rejected.headers.get("retry-after"));
    expect(delay).toBeGreaterThan(0);
    expect(await rejected.json()).toMatchObject({ error: "rate_limited", retry_after: delay });
    expect((await call(path, "GET", a.key)).status).toBe(200);
  });

  it("counts authenticated malformed sends against the same participant limit as valid sends", async () => {
    const s = await ok(signup());
    const r = await room(s.key);
    const a = await member(r.room_id, s.key);
    const b = await member(r.room_id, s.key, "다른 비서");
    const path = "/api/rooms/" + r.room_id + "/messages";
    vi.spyOn(Date, "now").mockReturnValue(Math.floor(Date.now() / 60_000) * 60_000 + 5_000);
    const attempts = await Promise.all(Array.from({ length: 7 }, () => call(path, "POST", a.key, { text: " " })));
    expect(attempts.map(r => r.status).sort()).toEqual([400, 400, 400, 400, 400, 400, 429]);
    const state = () => db.batch([
      db.prepare("SELECT bucket,count FROM rate_hits WHERE subject=? ORDER BY bucket").bind(a.participant_id),
      db.prepare("SELECT request_count,request_write_estimate FROM spaces WHERE id=?").bind(s.space_id),
      db.prepare("SELECT count(*) AS n FROM messages WHERE room_id=?").bind(r.room_id),
    ]).then(results => results.map(r => r.results));
    const before = await state();
    expect(before[0]).toEqual([{ bucket: "send", count: 6 }, { bucket: "send_day", count: 6 }]);
    expect(before[2]).toEqual([{ n: 0 }]);
    await denied(call(path, "POST", a.key, { text: "전송 제한 확인" }), 429, "rate_limited");
    expect(await state()).toEqual(before);
    await ok(call(path, "POST", b.key, { text: "다른 참가자의 정상 답" }));
  });

  it("stops new writes, stretches empty polls, then closes reads before the provider ceiling", async () => {
    const s = await ok(signup());
    const r = await room(s.key);
    const a = await member(r.room_id, s.key);
    const path = "/api/rooms/" + r.room_id + "/messages";
    await ok(call(path, "POST", s.key, { text: "서버에 남을 기존 글" }));
    const real = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(real + 60_000);
    const setEstimate = (count: number) => db.prepare(
      "UPDATE rate_hits SET count=? WHERE bucket='estimated_writes' AND subject='all' AND window_start=?",
    ).bind(count, dayStart()).run();
    const read = () => call(path, "GET", a.key);
    const state = () => db.batch([
      db.prepare("SELECT request_count,request_write_estimate FROM spaces WHERE id=?").bind(s.space_id),
      db.prepare("SELECT read_count,last_read_id,read_guard_at FROM participants WHERE id=?").bind(a.participant_id),
    ]).then(rows => rows.map(x => x.results[0]));
    const quota = async (response: Response, text = false) => {
      expect(response.status).toBe(429);
      const wait = Number(response.headers.get("retry-after"));
      expect(wait).toBe(86400 - Math.floor(Date.now() / 1000) % 86400);
      if (text) {
        expect(await response.text()).toMatch(/^error: quota\n오늘 .*UTC 자정/m);
      } else {
        expect(await response.json()).toMatchObject({ error: "quota", scope: "service_day", retry_after: wait });
      }
    };
    await setEstimate(STOP_MUTATIONS - 20);
    await quota(await call("/admin/rooms", "POST", env.TEST_OWNER_KEY, { name: "한도 확인" }));
    expect(await db.prepare("SELECT count(*) AS n FROM rooms WHERE owner_id='o_default'").first("n")).toBe(0);

    await setEstimate(STOP_MUTATIONS);
    const me = await (await call("/api/me", "GET", s.key)).json<{ usage: { service_capacity: unknown } }>();
    expect(me.usage.service_capacity).toMatchObject({ stage: "read_only", percent: 60 });
    await quota(await call(path, "POST", s.key, { text: "더 쓸 수 없는 글" }));
    await quota(await signup());
    expect((await ok(read())).messages.map(m => m.text)).toEqual(["서버에 남을 기존 글"]);

    await setEstimate(SLOW_READS);
    clock.mockReturnValue(real + 120_000);
    const before = await state();
    const delayed = await read();
    expect(delayed.status).toBe(429);
    expect(Number(delayed.headers.get("retry-after"))).toBe(240);
    expect(await state()).toEqual(before);

    // The batch guard sees the new limit even while the isolate still has the earlier phase cached.
    await setEstimate(STOP_TRAFFIC);
    await quota(await call("/r/" + r.room_id + "/read?k=" + a.key, "GET"), true);
    expect(await state()).toEqual(before);
    expect(await db.prepare("SELECT count(*) AS n FROM messages WHERE room_id=?").bind(r.room_id).first("n")).toBe(1);
  });

  it("reuses an address confirmation without storage and spends it once in a concurrent send", async () => {
    const s = await ok(signup());
    const r = await room(s.key);
    const a = await member(r.room_id, s.key);
    const b = await member(r.room_id, s.key, "다른 비서");
    const path = "/r/" + r.room_id;
    const clock = Math.floor(Date.now() / 60_000) * 60_000 + 5_000;
    vi.spyOn(Date, "now").mockReturnValue(clock);
    const read = async () => {
      const response = await call(path + "/read?k=" + a.key, "GET");
      expect(response.status).toBe(200);
      return /^# 보내기 확인값: (amt_v2_[\w-]+)$/m.exec(await response.text())?.[1];
    };
    const ticket = await read();
    expect(ticket).toBeTruthy();
    expect(await read()).toBe(ticket);
    expect(await db.prepare("SELECT count(*) AS n FROM send_tickets").first("n")).toBe(0);
    const send = (key: string, text: string) => call(path + "/send?" +
      new URLSearchParams({ k: key, c: ticket!, text }), "GET");
    expect((await send(b.key, "다른 키 답")).status).toBe(409);
    expect((await Promise.all([send(a.key, "첫 답"), send(a.key, "둘째 답")]))
      .map(r => r.status).sort()).toEqual([200, 409]);
    vi.spyOn(Date, "now").mockReturnValue(clock + 60_000);
    const after = await read();
    expect(after).not.toBe(ticket);
    const header = await call(path + "/messages", "GET", b.key);
    expect(header.status).toBe(200);
    expect(await header.json()).not.toHaveProperty("ticket");
    expect(await db.prepare("SELECT count(*) AS n FROM send_tickets").first("n")).toBe(0);
    vi.spyOn(Date, "now").mockReturnValue(clock + 31 * 60_000);
    const expired = await call(path + "/send?" + new URLSearchParams({ k: a.key, c: after!, text: "만료 확인" }), "GET");
    expect(expired.status).toBe(409);
  });

  it("limits the space owner to 60/min and shares one daily allowance with legacy and web participant routes", async () => {
    const s = await ok(signup()),
      r = await room(s.key),
      p = await member(r.room_id, s.key, "사람", "human");
    await db.prepare("UPDATE spaces SET request_minute_count=59,request_minute=unixepoch()/60*60 WHERE id=?").bind(s.space_id).run();
    await ok(call("/api/me", "GET", s.key));
    await denied(call("/api/me", "GET", s.key), 429, "rate_limited");
    await db.prepare("UPDATE spaces SET request_minute_count=0 WHERE id=?").bind(s.space_id).run();
    await db.prepare("UPDATE spaces SET request_count=?,request_day=unixepoch()/86400*86400 WHERE id=?").bind(LIMITS.space_day[0] - 1, s.space_id).run();
    await ok(call("/r/" + r.room_id + "/messages", "GET", p.key));
    await denied(call("/api/me", "GET", s.key), 429, "rate_limited");
    await denied(call("/api/rooms/" + r.room_id + "/messages", "GET", p.key), 429, "rate_limited");
    expect((await call("/r/" + r.room_id + "/read", "GET", p.key)).status).toBe(429);
  });

  it("keeps assets available without D1 and excludes health and assets from weighted admission", async () => {
    const healthy = await call("/healthz");
    expect(healthy.status).toBe(200);
    expect(await db.prepare("SELECT count(*) AS n FROM rate_hits WHERE bucket='estimated_writes'").first("n")).toBe(0);
    const broken = {
      ...local,
      DB: {
        prepare() {
          throw Error("D1 unavailable");
        },
      } as unknown as D1Database,
      ASSETS: {
        async fetch() {
          return new Response("shell");
        },
      } as unknown as Fetcher,
    };
    for (const path of ["/", "/app", "/r/example/", "/app.css"]) {
      const r = await call(path, "GET", undefined, undefined, broken);
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    }
    await denied(call("/app?k=invalid", "GET", undefined, undefined, broken), 404, "not_found");
    await denied(call("/app", "GET", newKey("amk_"), undefined, broken), 404, "not_found");
    await denied(call("/app", "GET", newKey("ams_"), undefined, broken), 404, "not_found");
    await ok(signup());
    expect(await db.prepare("SELECT count FROM rate_hits WHERE bucket='estimated_writes'").first("count")).toBe(SIGNUP_WRITE_WEIGHT);
  });

  it("recovers with the active member count and supports only revocation with a live space key while closed", async () => {
    const a = await ok(signup()),
      b = await ok(signup());
    const r = await room(a.key),
      q = await room(b.key);
    const p = await member(r.room_id, a.key),
      p2 = await member(r.room_id, a.key, "둘", "human"),
      other = await member(q.room_id, b.key, "다른 사람", "human");
    const restored = await ok(recover(a.recovery_codes[0]));
    expect(restored.active_participants).toBe(2);
    const closed = { ...local, KEY_EPOCH: "closed" };
    const path = "/api/rooms/" + r.room_id + "/participants/" + p.participant_id;
    await denied(call("/api/me/rotate", "POST", restored.key, {}, closed), 503, "key_epoch_invalid");
    await denied(call(path + "/reissue", "POST", restored.key, {}, closed), 503, "key_epoch_invalid");
    await denied(call(path + "/revoke", "POST", a.key, {}, closed), 403, "forbidden");
    await ok(call(path + "/revoke", "POST", restored.key, {}, closed));
    const bulk = "/api/me/participants/revoke-all";
    await denied(call(bulk, "POST", other.key, {}, closed), 403, "forbidden");
    expect((await ok(call(bulk, "POST", restored.key, {}, closed))).revoked_count).toBe(1);
    expect((await ok(call(bulk, "POST", restored.key, {}, closed))).revoked_count).toBe(0);
    await denied(call("/api/rooms/" + r.room_id + "/messages", "GET", p2.key), 403, "forbidden");
    await ok(call("/api/rooms/" + q.room_id + "/messages", "GET", other.key));
    await ok(call("/api/rooms/" + r.room_id + "/messages", "GET", restored.key));
  });

  it("limits invalid invites and recovery codes by source and groups IPv6 aliases under HMAC", async () => {
    const request = (ip: string) => new Request("http://127.0.0.1", { headers: { "cf-connecting-ip": ip } });
    const secured = { ...local, SOURCE_HASH_KEY: newKey("test_") };
    const a = await sourceOf(request("2001:db8:12::1"), secured);
    expect(a === (await sourceOf(request("2001:0db8:0012:0000:ffff::8"), secured))).toBe(true);
    expect(a === (await sourceOf(request("2001:db8:12:1::1"), secured))).toBe(false);
    expect(a === (await sourceOf(request("2001:db8:12::1"), { ...local, SOURCE_HASH_KEY: undefined }))).toBe(false);
    await denied(call("/api/spaces", "POST", undefined, { invite: "invalid", turnstile: testToken }), 403, "forbidden");
    expect(await db.prepare("SELECT count FROM rate_hits WHERE bucket='auth_fail'").first("count")).toBe(1);
    await db.prepare("UPDATE rate_hits SET count=29 WHERE bucket='auth_fail'").run();
    await denied(recover("invalid"), 403, "forbidden");
    await denied(signup(), 429, "rate_limited");
    await denied(recover("invalid"), 429, "rate_limited");
  });

  it("binds connection evidence and the room message boundary to the current credential", async () => {
    const s = await ok(signup()),
      r = await room(s.key);
    const path = "/api/rooms/" + r.room_id;
    const before = await ok(call(path + "/messages", "POST", s.key, { text: "발급 전" }));
    const p = await member(r.room_id, s.key);
    const info = async () =>
      (await ok(call(path + "/participants", "GET", s.key))).participants.find(
        (row) => row.participant_id === p.participant_id,
      )!;
    expect(await info()).toMatchObject({
      issued_at_message_id: before.id,
      first_read_at: null,
      last_read_at: null,
      status: "created",
    });
    await ok(call(path + "/messages", "GET", p.key));
    const stamp = (await info()).first_read_at;
    expect(typeof stamp).toBe("number");
    const after = await ok(call(path + "/messages", "POST", p.key, { text: "이전 키의 글" }));
    const fresh = await ok(call(path + "/participants/" + p.participant_id + "/reissue", "POST", s.key));
    await denied(call(path + "/messages", "GET", p.key), 403, "forbidden");
    expect(await info()).toMatchObject({
      issued_at_message_id: after.id,
      first_read_at: null,
      last_read_at: null,
      status: "created",
    });
    await ok(call(path + "/messages?since=0", "GET", fresh.key));
    const row = await info();
    expect(row.status).toBe("connected");
    expect(row.first_read_at).toBe(row.last_read_at);
    await db
      .prepare("UPDATE participants SET first_read_at=unixepoch()-700,last_read_at=unixepoch()-600,read_guard_at=unixepoch()-600 WHERE id=?")
      .bind(p.participant_id)
      .run();
    const first = (await info()).first_read_at;
    expect((await info()).status).toBe("last_seen");
    await ok(call(path + "/messages", "GET", fresh.key));
    expect((await info()).first_read_at).toBe(first);
  });
});

describe("v2.2 scoped conversations", () => {
  const pathOf = (id: string) => "/api/rooms/" + id;
  const patchMe = (key: string, body: unknown) => call("/api/me", "PATCH", key, body);

  it("requires a clear group call for 비서들 and 출첵 while preserving leading names and aliases", () => {
    const vooy = { id: "1", name: "부이1", ai_type: "vooy" };
    const pickle = { id: "2", name: "피클", ai_type: "pickle" };
    const members = [vooy, pickle];
    const all = members.map(({ id }) => ({ id, step: null, direct: false }));
    for (const text of ["비서들, 한 줄씩 알려주세요", "비서들 출첵", "출첵!", "출첵: 확인 부탁해요", "이 방의 @비서들 확인 부탁해요"]) {
      expect(routeQuestion(text, members), text).toEqual(all);
    }
    for (const text of ["내 비서들", "오늘은 비서들 이야기를 나눴어요", "비서들 모임은 내일입니다", "출첵 결과를 정리했어요"]) {
      expect(routeQuestion(text, members), text).toEqual([]);
    }
    const direct = [{ id: vooy.id, step: null, direct: true }];
    for (const text of ["부이, 출첵", "브이, 비서들 이야기를 정리해 주세요", "부이1, 오늘은 @비서들 이야기를 정리해 주세요"]) {
      expect(routeQuestion(text, members), text).toEqual(direct);
    }
    expect(routeQuestion("비서들: 확인", [{ ...vooy, name: "비서들" }, pickle])).toEqual(direct);
    expect(routeQuestion("출첵: 확인", [{ ...vooy, name: "출첵1" }, pickle])).toEqual(direct);
  });

  it("routes group calls only to active assistants and leaves ordinary posts unassigned", async () => {
    const owner = await ok(signup());
    const r = await ok(call("/api/rooms", "POST", owner.key, { name: "내 비서들" }));
    const other = await room(owner.key);
    const p = pathOf(r.room_id);
    const auto = await member(r.room_id, owner.key, "업무 비서");
    const manual = await ok(call(p + "/participants", "POST", owner.key, {
      name: "하크", kind: "assistant", ai_type: "hark",
    }));
    const revoked = await member(r.room_id, owner.key, "폐기 비서");
    await ok(call(p + "/participants/" + revoked.participant_id + "/revoke", "POST", owner.key));
    await member(r.room_id, owner.key, "사람 참가자", "human");
    await member(other.room_id, owner.key, "다른 방 비서");
    const post = (text: string) => ok(call(p + "/messages", "POST", owner.key, { text }));
    const all = await post("다들 출첵");
    const shortAll = await post("비서들 출첵");
    const roomName = await post("내 비서들");
    const direct = await post("업무 비서: 한 줄로 알려주세요");
    const plain = await post("오늘 일정은 다들 공유했습니다.");
    const read = async () => (await ok(call(p + "/messages?since=0", "GET", owner.key))).questions;
    const states = await read();
    for (const group of [all, shortAll]) {
      expect(states.filter((q) => q.question_id === group.id).map((q) => [q.participant_id, q.direct]))
        .toEqual([[auto.participant_id, 0], [manual.participant_id, 0]]);
    }
    expect(states.filter((q) => q.question_id === roomName.id)).toEqual([]);
    expect(states.filter((q) => q.question_id === direct.id).map((q) => [q.participant_id, q.direct]))
      .toEqual([[auto.participant_id, 1]]);
    expect(states.filter((q) => q.question_id === plain.id)).toEqual([]);
    await db.prepare("UPDATE messages SET question_route=json_remove(question_route,'$[0].direct') WHERE id=?").bind(direct.id).run();
    expect((await read()).find((q) => q.question_id === direct.id)).toMatchObject({
      participant_id: auto.participant_id, direct: 0,
    });
  });

  it("binds leading mentions, distinct room seats and the first valid ordered or manually relayed answers", async () => {
    const owner = await ok(signup());
    const r = await room(owner.key);
    const other = await ok(call("/api/rooms", "POST", owner.key, { name: "격리" }));
    const p = pathOf(r.room_id);
    const a = await member(r.room_id, owner.key, "피클1");
    const b = await member(r.room_id, owner.key, "피클2");
    await denied(call(p + "/participants", "POST", owner.key, { name: "피클1", kind: "assistant" }), 409, "name_taken");
    const vooy = await member(r.room_id, owner.key, "부이");
    const otherA = await member(other.room_id, owner.key, "피클1");
    const post = (key: string, body: unknown) => call(p + "/messages", "POST", key, body);
    const read = () => ok(call(p + "/messages?since=0", "GET", owner.key));

    await denied(post(owner.key, { text: "피클 확인 부탁해요" }), 400, "question_ambiguous");
    const addressed = await ok(post(owner.key, { text: "부이, 피클1 답을 비교해 주세요" }));
    expect((await read()).questions.filter((q) => q.question_id === addressed.id).map((q) => q.participant_id)).toEqual([vooy.participant_id]);
    const all = await ok(post(owner.key, { text: "전체: 한 줄씩 알려주세요" }));
    expect((await read()).questions.filter((q) => q.question_id === all.id)).toHaveLength(3);

    const ask = await ok(post(owner.key, { text: "피클1 → 부이: 정리 후 검토" }));
    await denied(post(otherA.key, { text: "다른 방의 답", reply_to: ask.id }), 403, "forbidden");
    await ok(post(vooy.key, { text: "미리 답한 글", reply_to: ask.id }));
    await ok(post(b.key, { text: "호명되지 않은 비서의 답", reply_to: ask.id }));
    expect((await read()).questions.filter((q) => q.question_id === ask.id && q.reply_id)).toHaveLength(0);
    await db.prepare("UPDATE messages SET created_at=unixepoch()-12 WHERE id=?").bind(ask.id).run();
    const first = await ok(post(a.key, { text: "피클이 정리한 첫 답입니다.", reply_to: ask.id }));
    await ok(post(a.key, { text: "피클이 추가로 쓴 답", reply_to: ask.id }));
    const stage = await ok(call(`/r/${r.room_id}/messages?since=${first.id}`, "GET", vooy.key));
    expect(stage.relay_turns).toEqual([{
      question_id: ask.id, preceding_reply_id: first.id, question: "피클1 → 부이: 정리 후 검토",
      preceding_reply: "피클이 정리한 첫 답입니다.",
    }]);
    const observed = (await ok(call(p + "/participants", "GET", owner.key))).participants.find((x) => x.participant_id === vooy.participant_id)?.last_read_at;
    const manual = await ok(post(owner.key, { text: "사람이 받은 부이 답", reply_to: first.id, relayed_for: vooy.participant_id }));
    const q = (await read()).questions.filter((x) => x.question_id === ask.id);
    expect(q.map((x) => x.reply_id)).toEqual([first.id, manual.id]);
    expect(q[0].answered_at! - q[0].asked_at).toBeGreaterThanOrEqual(12);
    expect((await ok(call(p + "/participants", "GET", owner.key))).participants.find((x) => x.participant_id === vooy.participant_id)?.last_read_at).toBe(observed);
    const excluded = await call("/s/invalid-fixture", "GET", undefined);
    expect(excluded.status).toBe(404);
    expect(await excluded.text()).not.toContain("STATUS:");
  });

  it("checks room and member limits inside concurrent creates and keeps pre-existing rows when lowered", async () => {
    const owner = await ok(signup());
    await denied(patchMe(owner.key, { room_limit: 31 }), 400, "invalid");
    await denied(patchMe(owner.key, { participant_limit: 51 }), 400, "invalid");
    await ok(patchMe(owner.key, { room_limit: 2, participant_limit: 2 }));
    const first = await room(owner.key);
    const openings = await Promise.all([
      call("/api/rooms", "POST", owner.key, { name: "방A" }),
      call("/api/rooms", "POST", owner.key, { name: "방B" }),
    ]);
    expect(openings.map((x) => x.status).sort()).toEqual([200, 429]);
    const p = pathOf(first.room_id) + "/participants";
    const joining = await Promise.all(["참가자A", "참가자B"].map((name) =>
      call(p, "POST", owner.key, { name, kind: "human" })));
    expect(joining.map((x) => x.status).sort()).toEqual([200, 429]);
    await ok(patchMe(owner.key, { room_limit: 1, participant_limit: 1 }));
    expect((await ok(call("/api/rooms", "GET", owner.key))).rooms).toHaveLength(2);
    expect((await ok(call(p, "GET", owner.key))).participants).toHaveLength(2);
    await denied(call(p, "POST", owner.key, { name: "추가 불가", kind: "human" }), 429, "quota");
    expect(await ok(patchMe(owner.key, { room_limit: 30, participant_limit: 50 })))
      .toMatchObject({ room_limit: 30, participant_limit: 50, retention_days: 30 });
  });

  it("applies each retention policy in reads, replies, exports, and cron while preserving explicit deletion", async () => {
    const a = await ok(signup());
    const b = await ok(signup());
    const r = await room(a.key);
    const other = await room(b.key);
    const p = pathOf(r.room_id), q = pathOf(other.room_id);
    const old = await ok(call(p + "/messages", "POST", a.key, { text: "보존 경계 글" }));
    const otherOld = await ok(call(q + "/messages", "POST", b.key, { text: "다른 공간의 오래된 글" }));
    const now = Math.floor(Date.now()/1000);
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    await db.batch([
      db.prepare("UPDATE messages SET created_at=? WHERE id=?").bind(now-7*86400,old.id),
      db.prepare("UPDATE messages SET created_at=? WHERE id=?").bind(now-100*86400,otherOld.id),
    ]);
    expect((await ok(call(p + "/messages?since=0", "GET", a.key))).messages).toHaveLength(1);
    await denied(patchMe(a.key, { retention_days: 7 }), 400, "invalid");
    await ok(patchMe(a.key, { retention_days: 7, confirm: "보관 기간 단축" }));
    await ok(patchMe(b.key, { retention_days: null }));
    expect((await ok(call(p + "/messages?since=0", "GET", a.key))).messages).toHaveLength(0);
    expect((await ok(call("/api/rooms", "GET", a.key))).rooms[0].last_message).toBeNull();
    await denied(call(p + "/messages", "POST", a.key, { text: "만료 글 답장", reply_to: old.id }), 400, "invalid");
    expect((await ok(call(p + "/export?format=txt", "GET", a.key))).chunk).toBe("");
    expect((await ok(call(q + "/messages?since=0", "GET", b.key))).messages.map((x) => x.id)).toEqual([otherOld.id]);
    await ok(patchMe(b.key, { retention_days: 90, confirm: "보관 기간 단축" }));
    expect((await ok(call(q + "/messages?since=0", "GET", b.key))).messages).toEqual([]);
    await db.prepare("UPDATE messages SET created_at=? WHERE id=?").bind(now-89*86400,otherOld.id).run();
    expect((await ok(call(q + "/messages?since=0", "GET", b.key))).messages.map((x) => x.id)).toEqual([otherOld.id]);
    await db.prepare("UPDATE messages SET created_at=? WHERE id=?").bind(now-90*86400,otherOld.id).run();
    expect((await ok(call(q + "/messages?since=0", "GET", b.key))).messages).toEqual([]);
    await ok(patchMe(b.key, { retention_days: null }));
    expect((await ok(call(q + "/export?format=md", "GET", b.key))).chunk).toContain("다른 공간의 오래된 글");
    expect(await purge(local)).toBe(1);
    await db.prepare("DELETE FROM messages WHERE created_at<=unixepoch()-30*86400").run();
    expect((await ok(call(q + "/export?format=txt", "GET", b.key))).chunk).toContain("다른 공간의 오래된 글");
    await ok(call(q, "DELETE", b.key));
    expect(await db.prepare("SELECT COUNT(*) n FROM messages WHERE room_id=?").bind(other.room_id).first("n")).toBe(0);
  });

  it("continues bounded mixed-age history without marking expired rows read or losing visible rows", async () => {
    const s = await ok(signup());
    const r = await room(s.key);
    const header = await member(r.room_id, s.key, "헤더 비서");
    const address = await member(r.room_id, s.key, "주소 비서");
    const clock = vi.spyOn(Date, "now");
    const now = dayStart() + 12 * 3600;
    clock.mockReturnValue(now * 1000);
    const cutoff = now - 30 * 86400;
    try {
      await db.prepare("WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<55)" +
        " INSERT INTO messages(room_id,participant_id,body,body_hash,created_at) SELECT ?,?,'expired','old'||n,? FROM seq")
        .bind(r.room_id, r.owner_participant_id, cutoff - 3600).run();
      for (const [text, time] of [["visible first", cutoff + 3600], ["visible second", cutoff + 60]] as const) {
        await db.prepare("INSERT INTO messages(room_id,participant_id,body,body_hash,created_at) VALUES(?,?,?,?,?)")
          .bind(r.room_id, r.owner_participant_id, text, text, time).run();
      }
      const p = pathOf(r.room_id);
      const hp = `/r/${r.room_id}/messages`;
      const first = await ok(call(hp, "GET", header.key));
      expect(first).toMatchObject({ messages: [], more: true });
      expect(first.next).toBeGreaterThan(0);
      expect(await db.prepare("SELECT last_read_id FROM participants WHERE id=?").bind(header.participant_id).first("last_read_id")).toBe(0);
      expect((await ok(call(hp, "GET", header.key))).messages.map((m) => m.text)).toEqual(["visible first", "visible second"]);
      const ap = `/r/${r.room_id}/read?k=${address.key}`;
      const a1 = await (await call(ap)).text();
      expect(a1).toContain(`# 다음 since: ${first.next}`);
      const a2 = await (await call(ap)).text();
      expect(a2).toContain("visible first");
      expect(a2).toContain("visible second");
      expect(a2).not.toContain("expired");
      const ep = p + "/export?format=json";
      const e1 = await ok(call(ep, "GET", s.key));
      expect(e1).toMatchObject({ chunk: "", more: true, next: first.next });
      await db.prepare("INSERT INTO messages(room_id,participant_id,body,body_hash,created_at) VALUES(?,?,?,?,?)")
        .bind(r.room_id, r.owner_participant_id, "new after snapshot", "new", now).run();
      const e2 = await ok(call(ep + `&since=${e1.next}&until=${e1.until}&policy=${encodeURIComponent(e1.policy)}`, "GET", s.key));
      expect(JSON.parse(`[${e2.chunk}]`).map((row: { text: string }) => row.text)).toEqual(["visible first", "visible second"]);
    } finally { clock.mockRestore(); }
  });

  it("opens on recent history then pages backward without moving the new-message cursor", async () => {
    const s = await ok(signup());
    const r = await room(s.key);
    const guest = await member(r.room_id, s.key, "사람", "human");
    const other = await room(s.key);
    const p = pathOf(r.room_id) + "/messages";
    await db.prepare("WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<121)" +
      " INSERT INTO messages(room_id,participant_id,body,body_hash,created_at) SELECT ?,?,'fixture '||n,'h'||n,unixepoch() FROM seq")
      .bind(r.room_id, r.owner_participant_id).run();
    await db.prepare("UPDATE messages SET created_at=unixepoch()-40*86400 WHERE room_id=? AND body IN (?,?,?)")
      .bind(r.room_id, "fixture 121", "fixture 73", "fixture 17").run();
    const first = await ok(call(p + "?latest=1", "GET", s.key));
    expect(first.messages[0].text).toBe("fixture 70");
    expect(first.messages.at(-1)?.text).toBe("fixture 120");
    expect(first.messages).toHaveLength(50);
    expect(first.previous).toBe(first.messages[0].id);
    const invited = await ok(call(p + "?latest=1", "GET", guest.key));
    expect(invited.messages).toEqual(first.messages);
    await denied(call(pathOf(other.room_id) + "/messages?latest=1", "GET", guest.key), 403, "forbidden");
    await denied(call(p + "?latest=1&since=0", "GET", s.key), 400, "invalid");
    const posted = await ok(call(p, "POST", s.key, { text: "새 글" }));
    expect((await ok(call(p + `?since=${first.next}`, "GET", s.key))).messages.map((m) => m.id)).toEqual([posted.id]);
    const seen = [...first.messages];
    let current = first.previous;
    for (let page = 0; current !== null && page < 4; page++) {
      const old = await ok(call(p + `?before=${current}`, "GET", s.key));
      expect(old.messages.every((m) => m.id < current!)).toBe(true);
      seen.unshift(...old.messages);
      current = old.previous;
    }
    expect(current).toBeNull();
    expect(seen.map((m) => m.text)).toEqual(Array.from({ length: 121 }, (_, i) => i + 1)
      .filter((i) => ![17, 73, 121].includes(i)).map((i) => `fixture ${i}`));
    expect(await db.prepare("SELECT last_read_id FROM participants WHERE id=?").bind(r.owner_participant_id).first("last_read_id")).toBe(posted.id);
  });

  it("exports stable authorized pages in four formats, neutralizes spreadsheet formulas and aborts on policy change", async () => {
    const owner = await ok(signup());
    const visitor = await ok(signup());
    const roomData = await room(owner.key);
    const p = pathOf(roomData.room_id);
    const guest = await member(roomData.room_id, owner.key, "손님", "human");
    const assistant = await member(roomData.room_id, owner.key);
    const samples = ["=SUM(1,2)", "한글과 \"따옴표\"\n둘째 줄", "[외부](https://example.invalid/)"];
    await db.batch(Array.from({length: 53}, (_, i) => db.prepare(
      "INSERT INTO messages(room_id,participant_id,body,body_hash,created_at) VALUES(?,?,?,?,unixepoch())",
    ).bind(roomData.room_id,roomData.owner_participant_id,samples[i] ?? `글 ${i}`,`fixture-${i}`)));
    const exportFrom = (format: string, key = owner.key, cursor = "") =>
      call(p + "/export?format=" + format + cursor, "GET", key);
    await denied(exportFrom("csv", visitor.key), 404, "not_found");
    await denied(exportFrom("csv", assistant.key), 403, "forbidden");
    const csv = await ok(exportFrom("csv", guest.key));
    expect(csv.chunk).toContain(`"'=SUM(1,2)"`);
    expect(csv.chunk).toContain('"한글과 ""따옴표""\n둘째 줄"');
    const md = await ok(exportFrom("md"));
    expect(md.chunk).toContain("    [외부](https://example.invalid/)");
    const txt = await ok(exportFrom("txt"));
    expect(txt.chunk).toContain(samples[1]);
    const first = await ok(exportFrom("json"));
    expect(first.more).toBe(true);
    await ok(call(p + "/messages", "POST", owner.key, { text: "내보내기 시작 뒤 새 글" }));
    const next = await ok(exportFrom("json", owner.key, `&since=${first.next}&until=${first.until}&policy=${first.policy}`));
    const all = JSON.parse("[" + first.chunk + "," + next.chunk + "]");
    expect(all).toHaveLength(53);
    expect(all[1].text).toBe(samples[1]);
    expect(all[0].created_at_utc).toMatch(/Z$/);
    await ok(patchMe(owner.key, { retention_days: 90 }));
    await ok(patchMe(owner.key, { retention_days: 30, confirm: "보관 기간 단축" }));
    await denied(exportFrom("json", owner.key, `&since=${first.next}&until=${first.until}&policy=${first.policy}`), 409, "policy_changed");
  });

  it("keeps uploaded image access in the authorized room and cleans replaced or revoked photos", async () => {
    const a = await ok(signup()), b = await ok(signup());
    const r = await room(a.key), other = await room(b.key);
    const p = pathOf(r.room_id);
    const guest = await member(r.room_id, a.key, "손님", "human");
    const target = await member(r.room_id, a.key, "비서");
    const endpoint = `${p}/participants/${target.participant_id}`;
    const thumb = "UklGRloAAABXRUJQVlA4IE4AAADQBACdASpgAGAAPqlUp08mJKOiIOgAwBUJaQB2AAAO7Kr5e4095N9OnTp06dOm+AD+tlf/43xBe1eP//wQW1HphnvWeBCk+icwgAAAAAA=";
    await denied(call(endpoint, "PATCH", guest.key, { avatar_preset: "muse" }), 403, "forbidden");
    await denied(call(endpoint, "PATCH", b.key, { avatar_preset: "muse" }), 404, "not_found");
    await denied(call(endpoint, "PATCH", a.key, { avatar_webp: btoa("<svg onload='x'/>") }), 400, "invalid");
    await denied(call(endpoint, "PATCH", a.key, { avatar_webp: thumb + "x" }), 400, "invalid");
    const uploaded = await ok(call(endpoint, "PATCH", a.key, { avatar_webp: thumb }));
    const query = "/avatars?versions=" + uploaded.avatar_rev;
    expect((await ok(call(p + query, "GET", guest.key))).avatars).toEqual([{ revision: uploaded.avatar_rev, webp: thumb }]);
    await denied(call(p + query, "GET", b.key), 404, "not_found");
    const otherGuest = await member(other.room_id, b.key, "다른 손님", "human");
    await denied(call(p + query, "GET", otherGuest.key), 403, "forbidden");
    expect((await ok(call(pathOf(other.room_id) + query, "GET", otherGuest.key))).avatars).toEqual([]);
    await ok(call(endpoint, "PATCH", a.key, { avatar_preset: "muse" }));
    expect((await ok(call(p + query, "GET", a.key))).avatars).toEqual([]);
    const replaced = await ok(call(endpoint, "PATCH", a.key, { avatar_webp: thumb }));
    await ok(call(`${p}/participants/${target.participant_id}/revoke`, "POST", a.key));
    expect((await ok(call(p + "/avatars?versions=" + replaced.avatar_rev, "GET", a.key))).avatars).toEqual([]);
  });

  it("atomically edits an existing assistant's profile without rotating credentials or moving history", async () => {
    const owner = await ok(signup()), outsider = await ok(signup());
    const r = await room(owner.key), other = await room(outsider.key);
    const p = pathOf(r.room_id);
    const seat = await ok(call(p + "/participants", "POST", owner.key, {
      name: "기존 비서", kind: "assistant", ai_type: "other", delivery: "header", device_label: "MacBook Air",
    }));
    const peer = await ok(call(p + "/participants", "POST", owner.key, {
      name: "다른 부이", kind: "assistant", ai_type: "vooy", device_label: "아이폰 SE2",
    }));
    const guest = await member(r.room_id, owner.key, "게스트", "human");
    const wrongRoom = await member(other.room_id, outsider.key, "다른 손님", "human");
    const oldQuestion = await ok(call(p + "/messages","POST",owner.key,{text:"기존 비서: 먼저 묻습니다"}));
    await ok(call(`/r/${r.room_id}/messages`,"GET",seat.key));
    const oldReply = await ok(call(p + "/messages","POST",seat.key,{text:"기존 답입니다.",reply_to:oldQuestion.id}));
    const path = p + "/participants/" + seat.participant_id;
    const get = async () => (await ok(call(p+"/participants","GET",owner.key))).participants
      .find((row) => row.participant_id === seat.participant_id)!;
    const before = await get();
    await denied(call(path,"PATCH",guest.key,{ai_type:"vooy"}),403,"forbidden");
    await denied(call(path,"PATCH",outsider.key,{device_label:"Windows PC"}),404,"not_found");
    await denied(call(path,"PATCH",owner.key,{name:"저장 금지",ai_type:"human",device_label:"Windows PC"}),400,"invalid");
    await denied(call(path,"PATCH",owner.key,{name:"저장 금지",avatar_preset:"unknown"}),400,"invalid");
    await denied(call(p+"/participants/"+guest.participant_id,"PATCH",owner.key,{ai_type:"vooy"}),400,"invalid");
    expect(await get()).toEqual(before);
    const changes = {name:"부이 업무 비서",ai_type:"vooy",check_interval_minutes:17,avatar_preset:"muse",
      device_label:"Windows PC",role_note:"검토 <중요> & 검증\n둘째 줄"};
    expect(await ok(call(path,"PATCH",owner.key,changes))).toMatchObject({
      participant_id:seat.participant_id,delivery:"header",ai_type:"vooy",interval_minutes:17,
      device_label:changes.device_label,role_note:changes.role_note,avatar_preset:"muse",
    });
    const after = await get();
    expect(after.last_read_at).toBe(before.last_read_at);
    expect((await ok(call(p+"/participants","GET",guest.key))).participants.find((x)=>x.participant_id===seat.participant_id))
      .toMatchObject({role_note:changes.role_note,device_label:"Windows PC"});
    const otherRows=(await ok(call(pathOf(other.room_id)+"/participants","GET",wrongRoom.key))).participants;
    expect(otherRows.some((x)=>x.participant_id===seat.participant_id)).toBe(false);
    expect((await ok(call(p+"/participants","GET",owner.key))).participants.find((x)=>x.participant_id===peer.participant_id)?.device_label)
      .toBe("아이폰 SE2");
    const newQuestion = await ok(call(p+"/messages","POST",owner.key,{text:"부이 업무 비서: 한 번 더 묻습니다"}));
    expect((await ok(call(`/r/${r.room_id}/messages`,"GET",seat.key))).messages.some((m)=>m.id===newQuestion.id)).toBe(true);
    await ok(call(p+"/messages","POST",seat.key,{text:"기존 열쇠로 쓴 새 답",reply_to:newQuestion.id}));
    expect((await ok(call(p+"/messages?since=0","GET",owner.key))).questions)
      .toContainEqual(expect.objectContaining({question_id:oldQuestion.id,participant_id:seat.participant_id,reply_id:oldReply.id}));
    await ok(call(path,"PATCH",owner.key,{role_note:"",device_label:null}));
    expect(await get()).toMatchObject({ai_type:"vooy",role_note:null,device_label:null,name:"부이 업무 비서"});
  });

  it("fails closed if retention changes between fetching a page and committing its read position", async () => {
    const owner = await ok(signup());
    const r = await room(owner.key);
    const p = pathOf(r.room_id) + "/messages";
    const old = await ok(call(p, "POST", owner.key, { text: "보관 변경 전 글" }));
    await db.prepare("UPDATE messages SET created_at=unixepoch()-8*86400 WHERE id=?").bind(old.id).run();
    let raced = false;
    const racingDb: D1Database = {
      ...db,
      prepare: db.prepare.bind(db),
      async batch(statements) {
        if (!raced) {
          raced = true;
          await db.prepare("UPDATE spaces SET retention_days=7 WHERE id=?").bind(owner.space_id).run();
        }
        return db.batch(statements);
      },
      exec: db.exec.bind(db),
      dump: db.dump.bind(db),
      withSession: db.withSession.bind(db),
    };
    await denied(call(p, "GET", owner.key, undefined, { ...local, DB: racingDb }), 409, "policy_changed");
    expect((await ok(call(p, "GET", owner.key))).messages).toEqual([]);
  });
});
