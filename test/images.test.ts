import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker, { newId, newKey, purge, sha256hex } from "../src/app";
import { dayStart } from "../src/budget";
import { decodeImageBase64, inspectImage } from "../src/image-data";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAHElEQVR42mOUbGr6zwAFTAwMDAzP6+oYGRgYGAA+KgQEG4yYOQAAAABJRU5ErkJggg==";
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAMDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAdEAACAgEFAAAAAAAAAAAAAAABAgADEQQFEyGR/8QAFQEBAQAAAAAAAAAAAAAAAAAABAb/xAAXEQADAQAAAAAAAAAAAAAAAAAAATEC/9oADAMBAAIRAxEAPwCX252fTOXYsee4ZJz0LGAHkREeoSOqz//Z";
const WEBP = "UklGRiAAAABXRUJQVlA4TBQAAAAvAkAAEA8wgpMxgvMf8HjBQUT/Iw==";
const db = env.DB;
const bindings = { ...env, SOURCE_HASH_KEY: "image-fixture-only", KEY_EPOCH: "0", IMAGE_UPLOADS: "on" };
const png = () => decodeImageBase64(PNG);
afterEach(() => vi.restoreAllMocks());

function join(...parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let i = 0;
  for (const part of parts) { result.set(part, i); i += part.length; }
  return result;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value;
});
function pngSection(type: string, bytes: Uint8Array) {
  const result = new Uint8Array(bytes.length + 12);
  const view = new DataView(result.buffer);
  view.setUint32(0, bytes.length);
  result.set(new TextEncoder().encode(type), 4);
  result.set(bytes, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < result.length - 4; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ result[i]) & 255];
  view.setUint32(result.length - 4, (crc ^ 0xffffffff) >>> 0);
  return result;
}

async function fixture() {
  const space = newId(), room = newId(), owner = newKey("ams_");
  const first = { id: newId(), key: newKey("amk_") };
  const guest = { id: newId(), key: newKey("amk_") };
  const address = { id: newId(), key: newKey("amk_") };
  await db.batch([
    db.prepare("INSERT INTO spaces(id,key_hash,key_epoch,created_at,last_seen_at) VALUES(?,?,0,unixepoch(),unixepoch())")
      .bind(space, await sha256hex(owner)),
    db.prepare("INSERT INTO rooms(id,owner_id,name,created_at) VALUES(?,?,?,unixepoch())").bind(room, space, "합성 방"),
    db.prepare("INSERT INTO participants(id,room_id,kind,name,is_owner,key_hash,created_at,key_epoch) VALUES(?,?,'human','방장',1,?,unixepoch(),0)")
      .bind(newId(), room, await sha256hex(newKey("internal_"))),
    ...await Promise.all([first, guest, address].map(async (p, index) => db.prepare(
      "INSERT INTO participants(id,room_id,kind,name,key_hash,created_at,key_epoch,delivery) VALUES(?,?,?,?,?,unixepoch(),0,?)",
    ).bind(p.id, room, index === 1 ? "human" : "assistant", "테스트 " + index,
      await sha256hex(p.key), index === 2 ? "get" : "header"))),
  ]);
  return { space, room, owner, first, guest, address };
}

function call(
  route: string,
  { method = "GET", key, body, headers = {}, enabled = true, settings = {} }:
    { method?: string; key?: string; body?: BodyInit; headers?: Record<string, string>; enabled?: boolean; settings?: Record<string,string> } = {},
) {
  const auth = key?.startsWith("ams_") ? { authorization: "Bearer " + key } : key ? { "x-mailbox-key": key } : {};
  return worker.fetch(new Request("https://mailbox.example.test" + route, {
    method, body, headers: { ...auth, ...headers } as Record<string,string>,
  }), { ...bindings, ...settings, IMAGE_UPLOADS: enabled ? "on" : "off" });
}

const publish = (url: string, key: string, text = "", body = png()) => call(url, {
  method: "POST", key, body: body.buffer as ArrayBuffer,
  headers: { "content-type": "image/png", "x-mailbox-text": encodeURIComponent(text) },
});
const getId = async (response: Response) => {
  const result = await response.json<{ id?: number }>();
  expect(response.status, JSON.stringify(result)).toBe(200);
  expect(result.id).toBeTypeOf("number");
  return result.id!;
};

it("strips PNG and JPEG metadata and accepts static WebP", () => {
  const original = png();
  const tagged = join(original.subarray(0, 33),
    pngSection("tEXt", new TextEncoder().encode("location\0secret fixture")), original.subarray(33));
  expect(inspectImage("image/png", tagged).data).toEqual(original);
  const jpg = decodeImageBase64(JPEG), metadata = Uint8Array.from([255,225,0,8,69,120,105,102,0,0]);
  const cleaned = inspectImage("image/jpeg", join(jpg.subarray(0,2), metadata, jpg.subarray(2)));
  expect(cleaned).toEqual(inspectImage("image/jpeg", jpg));
  expect(cleaned.data.length).toBeLessThan(jpg.length);
  const webp = decodeImageBase64(WEBP);
  const profiled = join(webp.subarray(0, 12),
    new Uint8Array([86,80,56,88,10,0,0,0,48,0,0,0,2,0,0,1,0,0]), // VP8X ICC flag
    new Uint8Array([73,67,67,80,2,0,0,0,16,17]), webp.subarray(12));
  new DataView(profiled.buffer).setUint32(4, profiled.length - 8, true);
  const clean = inspectImage("image/webp", profiled);
  expect(clean).toMatchObject({ width: 3, height: 2 });
  expect(clean.data.length).toBe(profiled.length - 10);
  expect(clean.data[20]).toBe(16);
  expect(inspectImage("image/webp", clean.data).data).toEqual(clean.data);
  expect(inspectImage("image/webp", webp)).toMatchObject({ width: 3, height: 2 });
});

it("rejects MIME mismatch, broken structures, oversize, animation and non-raster input", () => {
  const original = png();
  expect(() => inspectImage("image/svg+xml", new Uint8Array([60,62]))).toThrow("image_unsupported");
  expect(() => inspectImage("image/gif", new Uint8Array([71,73,70]))).toThrow("image_unsupported");
  expect(() => inspectImage("image/jpeg", original)).toThrow("image_invalid");
  expect(() => inspectImage("image/png", original.subarray(0,-1))).toThrow("image_invalid");
  const wrongCrc = original.slice(); wrongCrc[35] ^= 1;
  expect(() => inspectImage("image/png", wrongCrc)).toThrow("image_invalid");
  const badDimensions = original.slice(16,29);
  new DataView(badDimensions.buffer).setUint32(0, 2049);
  expect(() => inspectImage("image/png", join(original.subarray(0,8),
    pngSection("IHDR", badDimensions), original.subarray(33)))).toThrow("image_dimensions");
  expect(() => inspectImage("image/png", join(original.subarray(0,33),
    pngSection("acTL", new Uint8Array(8)), original.subarray(33)))).toThrow("image_unsupported");
  const webp = decodeImageBase64(WEBP);
  const animated = join(webp.subarray(0,12), Uint8Array.from([86,80,56,88,10,0,0,0,2,0,0,0,2,0,0,1,0,0]), webp.subarray(12));
  new DataView(animated.buffer).setUint32(4, animated.length - 8, true);
  expect(() => inspectImage("image/webp", animated)).toThrow("image_unsupported");
  expect(() => inspectImage("image/png", new Uint8Array(1_100_001))).toThrow("image_too_large");
});

it("uploads from all authorized paths, exports metadata, and keeps reads private after switching off", async () => {
  const f = await fixture(), outside = await fixture();
  const p = "/r/" + f.room, api = "/api/rooms/" + f.room;
  expect((await publish(p + "/image", f.address.key)).status).toBe(415);
  expect((await call(p + "/send", { method: "POST", key: f.address.key,
    body: JSON.stringify({ image_type: "image/webp", image_base64: WEBP }),
    headers: { "content-type": "application/json" } })).status).toBe(415);
  const one = await getId(await publish(p + "/image", f.first.key, "그림 설명"));
  const two = await getId(await call(p + "/send", { method: "POST", key: f.first.key,
    body: JSON.stringify({ image_type: "image/webp", image_base64: WEBP, reply_to: one }),
    headers: { "content-type": "application/json" } }));
  const relay = await getId(await call(api + "/image?reply_to=" + one, {
    method: "POST", key: f.owner, body: png().buffer as ArrayBuffer,
    headers: { "content-type": "image/png", "x-mailbox-relayed-for": f.address.id },
  }));
  const guest = await getId(await publish(api + "/image", f.guest.key));
  expect(guest).toBeGreaterThan(relay);
  expect((await call(api + "/image", { method: "POST", key: f.guest.key, body: png().buffer as ArrayBuffer,
    headers: { "content-type": "image/png", "x-mailbox-relayed-for": f.address.id } })).status).toBe(403);
  const json = await (await call(api + "/messages?since=0", { key: f.owner })).json<{
    messages: { id: number; text: string; image: object; relay_label: string; relayed_for: string; reply_to: number }[];
  }>();
  expect(json.messages).toHaveLength(4);
  expect(json.messages[0]).toMatchObject({ id: one, text: "그림 설명", image: { mime: "image/png", width: 3, height: 2 } });
  expect(json.messages[1]).toMatchObject({ id: two, text: "", reply_to: one, image: { mime: "image/webp" } });
  expect(json.messages[2]).toMatchObject({ id: relay, relayed_for: f.address.id, relay_label: "사용자가 대신 올림" });
  const rawRead = await (await call(p + "/read?since=0&k=" + f.address.key)).text();
  expect(rawRead).toContain(`\n[이미지 #${one} image/png 1KB 3×2]\n    그림 설명`);
  const withKey = await call(p + "/image/" + one + "?k=" + f.address.key, { enabled: false });
  expect(withKey.status).toBe(200);
  expect(withKey.headers.get("cache-control")).toBe("private, no-store");
  expect(withKey.headers.get("content-type")).toBe("image/png");
  expect(withKey.headers.get("content-security-policy")).toContain("sandbox");
  expect(new Uint8Array(await withKey.arrayBuffer())).toEqual(png());
  expect((await call(api + "/image/" + one, { key: f.guest.key })).status).toBe(200);
  expect((await call(p + "/image/" + one, { key: outside.guest.key })).status).toBe(403);
  expect((await call(p + "/image/" + one)).status).toBe(401);
  expect((await call(p + "/image/" + one + "?k=" + f.first.key)).status).toBe(403);
  expect((await call(api + "/image/" + one, { method: "DELETE", key: f.guest.key })).status).toBe(403);
  expect((await call("/api/rooms/" + outside.room + "/image/" + one, { method: "DELETE", key: f.owner })).status).toBe(404);
  expect((await call(api + "/image", { method: "POST", key: f.owner, body: png().buffer as ArrayBuffer,
    headers: { "content-type": "image/png" }, enabled: false })).status).toBe(503);
  for (const format of ["md", "csv", "txt", "json"]) {
    const res = await call(api + "/export?format=" + format, { key: f.owner });
    expect(res.status).toBe(200);
    const { chunk } = await res.json<{ chunk: string }>();
    expect(chunk).toContain("image/png");
    expect(chunk).toMatch(/[a-f0-9]{64}/);
    expect(chunk).not.toContain(PNG);
  }
  expect((await call(api + "/image/" + one, { method: "DELETE", key: f.owner })).status).toBe(200);
  expect((await call(api + "/image/" + one, { key: f.owner })).status).toBe(404);
  const roomMeta = await (await call(api + "/messages", { key: f.owner })).json<{ room: { image_revision: number } }>();
  expect(roomMeta.room.image_revision).toBe(1);
  await db.prepare("UPDATE participants SET revoked=1 WHERE id=?").bind(f.guest.id).run();
  expect((await call(p + "/image/" + two, { key: f.guest.key })).status).toBe(403);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM message_images").first("n")).toBe(3);
  expect((await call(api, { method: "DELETE", key: f.owner })).status).toBe(200);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM message_images").first("n")).toBe(0);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM image_storage").first("n")).toBe(0);
});

it("shares participant, daily and storage limits and removes images on retention", async () => {
  const f = await fixture();
  const p = "/r/" + f.room + "/image";
  const attempts = await Promise.all(["하나", "둘", "셋"].map(text => publish(p, f.first.key, text)));
  expect(attempts.map(r => r.status).sort()).toEqual([200, 200, 429]);
  const limited = attempts.find(r => r.status === 429)!;
  expect(limited.headers.has("retry-after")).toBe(true);
  expect(await limited.json()).toMatchObject({ error: "rate_limited", scope: "participant_minute" });
  await db.prepare("UPDATE rate_hits SET count=10 WHERE bucket='image_space_day' AND subject=? AND window_start=?")
    .bind(f.space, dayStart()).run();
  const dayLimit = await publish(p, f.guest.key, "공간 하루 한도");
  expect(dayLimit.status).toBe(429);
  expect(await dayLimit.json()).toMatchObject({ error: "quota", scope: "space_daily" });
  await db.prepare("UPDATE rate_hits SET count=0 WHERE bucket='image_space_day' AND subject=?").bind(f.space).run();
  await db.prepare("UPDATE image_storage SET bytes=300000000 WHERE owner_id=''").run();
  const siteLimit = await publish(p, f.guest.key, "전체 저장 한도");
  expect(await siteLimit.json()).toMatchObject({ error: "quota", scope: "site_storage" });
  await db.prepare("UPDATE image_storage SET bytes=(SELECT SUM(bytes) FROM message_images) WHERE owner_id=''").run();
  await db.prepare("UPDATE messages SET created_at=unixepoch()-31*86400 WHERE room_id=?").bind(f.room).run();
  const existing = await db.prepare("SELECT message_id FROM message_images LIMIT 1").first<number>("message_id");
  expect((await call("/r/" + f.room + "/image/" + existing, { key: f.guest.key })).status).toBe(404);
  await purge(bindings);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM message_images").first("n")).toBe(0);
  expect(await db.prepare("SELECT COUNT(*) AS n FROM image_storage").first("n")).toBe(0);
});

it("round-trips a near-limit image through workerd D1 without including its bytes in message JSON", async () => {
  const width = 498, height = 501;
  const pixels = new Uint8Array((width * 4 + 1) * height);
  let random = 0x121f4321;
  for (let i = 0; i < pixels.length; i++) {
    random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
    pixels[i] = i % (width * 4 + 1) === 0 ? 0 : random & 255;
  }
  const compressed = new Uint8Array(await new Response(new Blob([pixels]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const hdr = new Uint8Array(13);
  const view = new DataView(hdr.buffer);
  view.setUint32(0,width); view.setUint32(4,height); hdr[8] = 8; hdr[9] = 6;
  const input = join(png().subarray(0,8), pngSection("IHDR", hdr), pngSection("IDAT", compressed), pngSection("IEND", new Uint8Array()));
  expect(input.length).toBeGreaterThan(990_000);
  expect(input.length).toBeLessThanOrEqual(1_000_000);
  const f = await fixture(), p = "/r/" + f.room;
  const id = await getId(await call(p + "/image", {
    method: "POST", key: f.first.key, body: input.buffer as ArrayBuffer,
    headers: { "content-type": "image/png" }, settings: { IMAGE_MAX_BYTES: "1000000" },
  }));
  const reply = await call(p + "/image/" + id, { key: f.first.key });
  expect(reply.headers.get("content-length")).toBe(String(input.length));
  const downloaded = new Uint8Array(await reply.arrayBuffer());
  expect(downloaded.length).toBe(input.length);
  for (let i = 0; i < input.length; i += 1_000) expect(downloaded[i]).toBe(input[i]);
  const json = await (await call(p + "/messages", { key: f.first.key })).text();
  expect(json.length).toBeLessThan(2000);
  expect(JSON.parse(json).messages[0].image).toEqual({ mime: "image/png", bytes: input.length, width, height });
});

it("applies deployment byte and count settings and leaves ordinary text available", async () => {
  const f = await fixture(), p = "/r/" + f.room;
  const image = { method: "POST", key: f.first.key, body: png().buffer as ArrayBuffer,
    headers: { "content-type": "image/png" } };
  const small = await call(p + "/image", { ...image, settings: { IMAGE_MAX_BYTES: "60" } });
  expect(small.status).toBe(413);
  expect(await small.json()).toEqual({ error: "image_too_large", image_max_bytes: 60, image_max_edge: 2048 });
  const narrow = await call(p + "/image", { ...image, settings: { IMAGE_MAX_EDGE: "2" } });
  expect(narrow.status).toBe(413);
  expect(await narrow.json()).toEqual({ error: "image_dimensions", image_max_bytes: 48000, image_max_edge: 2 });
  const accepted = await call(p + "/image", { ...image, settings: { IMAGE_SPACE_DAILY: "1", IMAGE_MAX_EDGE: "0" } });
  expect(accepted.status).toBe(200);
  const count = await call(p + "/image", { ...image, settings: { IMAGE_SPACE_DAILY: "1" } });
  expect(await count.json()).toMatchObject({ error: "quota", scope: "space_daily" });
  const usage = await (await call("/api/me", { key: f.owner,
    settings: { IMAGE_MAX_BYTES: "60", IMAGE_SPACE_DAILY: "1", IMAGE_MAX_EDGE: "0" } })).json();
  expect(usage).toMatchObject({ limits: { image_max_bytes: 60, image_max_edge: 2048, images_per_day: 1 },
    usage: { image_storage_bytes: png().length, images_today: 1 } });
  const text = await call(p + "/send", { method: "POST", key: f.first.key,
    body: JSON.stringify({ text: "이미지 한도와 일반 글의 분리" }), headers: { "content-type": "application/json" },
    settings: { IMAGE_SPACE_DAILY: "1" } });
  expect(text.status).toBe(200);
});

it("bypasses history scans on assistant-only arrivals during cooldown, then allows the next human post", async () => {
  const f = await fixture(), p = "/r/" + f.room;
  for (const n of [1, 2]) expect((await call(p + "/messages", { key: f.first.key })).status, String(n)).toBe(200);
  const indexed = "SELECT id FROM messages WHERE room_id=? AND human_origin=1 AND id>? ORDER BY id DESC LIMIT 1";
  await db.prepare("INSERT INTO messages(room_id,participant_id,body,body_hash,created_at)" +
    " SELECT ?1,?2,'비서 글 '||value,'assistant:'||value,unixepoch() FROM json_each(?3)")
    .bind(f.room, f.address.id, JSON.stringify(Array.from({ length: 50 }, (_, index) => index))).run();
  const { meta, results } = await db.prepare(indexed).bind(f.room, 0).all();
  expect(results).toHaveLength(0);
  expect(meta.rows_read).toBeLessThanOrEqual(2);
  const plan = await db.prepare("EXPLAIN QUERY PLAN " + indexed).bind(f.room, 0).all();
  expect(JSON.stringify(plan.results)).toContain("messages_room_human_id");
  const rate = await call(p + "/messages", { key: f.first.key });
  expect(rate.status).toBe(429);
  expect(+rate.headers.get("retry-after")!).toBeGreaterThan(0);
  const newest = await db.prepare("DELETE FROM messages WHERE room_id=? AND human_origin=0 AND id NOT IN" +
    "(SELECT MAX(id) FROM messages WHERE room_id=?) RETURNING id").bind(f.room, f.room).all();
  expect(newest.results).toHaveLength(49);
  const human = await call("/api/rooms/" + f.room + "/messages", { method: "POST", key: f.owner,
    body: JSON.stringify({ text: "사람 글 즉시 확인" }), headers: { "content-type": "application/json" } });
  expect(human.status).toBe(200);
  const who = await call(p + "/messages", { key: f.first.key });
  expect(who.status).toBe(200);
  expect(await who.json()).toMatchObject({ messages: [{ text: "비서 글 49" }, { text: "사람 글 즉시 확인" }] });
});

it("can relay the same image without a caption for both delivery modes, and still rejects the same author retry", async () => {
  const now = Math.floor(Date.now() / 60_000) * 60_000 + 10_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const f = await fixture(), api = "/api/rooms/" + f.room;
  const image = (target?: string) => call(api + "/image", { method: "POST", key: f.owner,
    body: png().buffer as ArrayBuffer, headers: { "content-type": "image/png",
      ...(target ? { "x-mailbox-relayed-for": target } : {}) },
  });
  await getId(await image());
  await getId(await image(f.address.id));
  clock.mockReturnValue(now + 60_000);
  await getId(await image(f.first.id));
  const again = await image(f.first.id);
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ error: "duplicate" });
  const replies = await (await call(api + "/messages?since=0", { key: f.owner })).json<{
    messages: { text: string; relayed_for: string | null; image: unknown }[];
  }>();
  expect(replies.messages.map(m => [m.text, m.relayed_for, Boolean(m.image)]))
    .toEqual([["", null, true], ["", f.address.id, true], ["", f.first.id, true]]);
});

it("advances rather than bouncing at cooldown when the new human post is behind the first page", async () => {
  const f = await fixture(), p = "/r/" + f.room, read = () => call(p + "/messages?since=0", { key: f.first.key });
  expect((await read()).status).toBe(200);
  expect((await read()).status).toBe(200);
  await db.prepare("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<60)" +
    " INSERT INTO messages(room_id,participant_id,body,body_hash,created_at)" +
    " SELECT ?,?,'비서 글 '||n,'assistant:'||n,unixepoch() FROM seq").bind(f.room, f.address.id).run();
  const human = await call("/api/rooms/" + f.room + "/messages", { method: "POST", key: f.owner,
    body: JSON.stringify({ text: "페이지 너머 사람 글" }), headers: { "content-type": "application/json" } });
  expect(human.status).toBe(200);
  const first = await read();
  expect(first.status).toBe(200);
  const firstData = await first.json<{ messages: { id: number; text: string }[]; more: boolean }>();
  expect(firstData.messages).toHaveLength(50);
  expect(firstData.more).toBe(true);
  const second = await read(); // A stale since cannot repeatedly consume the already delivered page.
  expect(second.status).toBe(200);
  const secondData = await second.json<{ messages: { id: number; text: string }[]; more: boolean }>();
  expect(secondData.messages).toHaveLength(11);
  expect(secondData.messages[0].id).toBeGreaterThan(firstData.messages.at(-1)!.id);
  expect(secondData.messages.at(-1)?.text).toBe("페이지 너머 사람 글");
  expect(secondData.more).toBe(false);
  expect((await read()).status).toBe(429);
});
